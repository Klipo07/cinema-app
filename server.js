var express = require('express');
var path = require('path');
var crypto = require('crypto');
var { Pool } = require('pg');
var { MongoClient } = require('mongodb');
var redis = require('redis');

var app = express();
var PORT = 3000;

// ======================== СОСТОЯНИЕ ========================

var dbStatus = { postgresql: false, mongodb: false, redis: false };

// ======================== ПОДКЛЮЧЕНИЯ К БД ========================

var pgPool = new Pool({
  host: 'localhost', port: 5432,
  user: 'postgres', password: 'postgres', database: 'cinema',
});

var mongoDB;
var mongoClient = new MongoClient('mongodb://localhost:27017', { serverSelectionTimeoutMS: 5000 });

var redisClient;

async function connectPostgres() {
  try {
    var r = await pgPool.query('SELECT NOW()');
    console.log('[PostgreSQL] Подключено:', r.rows[0].now);
    dbStatus.postgresql = true;
  } catch (err) {
    console.error('[PostgreSQL] НЕ УДАЛОСЬ подключиться:', err.message);
    dbStatus.postgresql = false;
  }
}

async function connectMongo() {
  try {
    await mongoClient.connect();
    mongoDB = mongoClient.db('cinema');
    console.log('[MongoDB] Подключено к базе cinema');
    dbStatus.mongodb = true;
  } catch (err) {
    console.error('[MongoDB] НЕ УДАЛОСЬ подключиться:', err.message);
    dbStatus.mongodb = false;
  }
}

async function connectRedis() {
  try {
    redisClient = redis.createClient({ url: 'redis://localhost:6379' });
    redisClient.on('error', function(err) { console.error('[Redis] Ошибка:', err.message); dbStatus.redis = false; });
    redisClient.on('ready', function() { dbStatus.redis = true; });
    await redisClient.connect();
    console.log('[Redis] Подключено');
    dbStatus.redis = true;
  } catch (err) {
    console.error('[Redis] НЕ УДАЛОСЬ подключиться:', err.message);
    dbStatus.redis = false;
  }
}

async function connectDatabases() {
  await connectPostgres();
  await connectMongo();
  await connectRedis();
  if (!dbStatus.postgresql || !dbStatus.mongodb || !dbStatus.redis) {
    console.warn('\n[WARN] Некоторые БД недоступны:', JSON.stringify(dbStatus));
  }
}

// ======================== MIDDLEWARE ========================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ======================== HEALTH CHECK ========================

app.get('/api/health', async function(req, res) {
  try { await pgPool.query('SELECT 1'); dbStatus.postgresql = true; } catch(e) { dbStatus.postgresql = false; }
  try {
    if (mongoDB) { await mongoDB.admin().ping(); dbStatus.mongodb = true; }
    else { dbStatus.mongodb = false; }
  } catch(e) { dbStatus.mongodb = false; }
  try {
    if (redisClient && redisClient.isOpen) { await redisClient.ping(); dbStatus.redis = true; }
    else { dbStatus.redis = false; }
  } catch(e) { dbStatus.redis = false; }
  res.json(dbStatus);
});

// ======================== ФИЛЬМЫ (PostgreSQL) ========================

app.get('/api/movies', async function(req, res) {
  try {
    console.log('[PostgreSQL] SELECT * FROM movies — получение списка фильмов');
    var result = await pgPool.query('SELECT * FROM movies ORDER BY rating DESC NULLS LAST');
    console.log('[PostgreSQL] Найдено фильмов:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies/:id', async function(req, res) {
  try {
    console.log('[PostgreSQL] SELECT movie WHERE id =', req.params.id);
    var result = await pgPool.query('SELECT * FROM movies WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Фильм не найден' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Добавить фильм (без автоматических сеансов, рейтинг = NULL — будет из отзывов)
app.post('/api/movies', async function(req, res) {
  var title = req.body.title;
  var genre = req.body.genre;
  var duration_min = req.body.duration_min;
  var director = req.body.director;
  var description = req.body.description;
  var poster_url = req.body.poster_url;
  if (!title || !genre || !duration_min || !director) {
    return res.status(400).json({ error: 'Заполните: название, жанр, длительность, режиссёр' });
  }
  try {
    console.log('[PostgreSQL] INSERT INTO movies:', title);
    var r = await pgPool.query(
      'INSERT INTO movies (title, genre, duration_min, director, description, rating, poster_url) VALUES ($1,$2,$3,$4,$5,NULL,$6) RETURNING *',
      [title, genre, parseInt(duration_min), director, description || '', poster_url || null]
    );
    console.log('[PostgreSQL] Фильм добавлен, id:', r.rows[0].id);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Создать сеансы для фильма (ручной выбор залов, дней и времени)
app.post('/api/sessions', async function(req, res) {
  var movie_id = req.body.movie_id;
  var hall_ids = req.body.hall_ids;
  var days = parseInt(req.body.days) || 3;
  var times = req.body.times || ['10:00','14:00','19:00'];
  if (!movie_id || !hall_ids || hall_ids.length === 0)
    return res.status(400).json({ error: 'Укажите фильм и залы' });
  try {
    var prices = {'Стандарт':350,'Комфорт':450,'IMAX':550,'VIP':700};
    var hallsR = await pgPool.query('SELECT * FROM halls WHERE id = ANY($1)', [hall_ids]);
    var halls = hallsR.rows;
    var count = 0;
    for (var d = 1; d <= days; d++) {
      for (var h = 0; h < halls.length; h++) {
        for (var t = 0; t < times.length; t++) {
          var p = prices[halls[h].hall_type] || 400;
          if (parseInt(times[t]) >= 19) p += 100;
          try {
            await pgPool.query(
              "INSERT INTO sessions (movie_id,hall_id,start_time,price) VALUES ($1,$2,NOW()+($3||' days')::INTERVAL+$4::TIME,$5)",
              [movie_id, halls[h].id, d, times[t], p]
            );
            count++;
          } catch(e) {}
        }
      }
    }
    console.log('[PostgreSQL] Создано сеансов:', count, 'для movie_id:', movie_id);
    res.status(201).json({ created: count });
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Поиск фильмов через Kinopoisk API (русский язык, без VPN)
app.get('/api/poster-search', async function(req, res) {
  var query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Укажите название фильма' });

  var https = require('https');
  var KP_KEY = '228b4e23-4174-464f-87a7-5e6c0b191ceb';

  try {
    console.log('[Кинопоиск] Поиск фильмов:', query);

    var options = {
      hostname: 'kinopoiskapiunofficial.tech',
      path: '/api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(query) + '&page=1',
      headers: { 'X-API-KEY': KP_KEY, 'Content-Type': 'application/json' }
    };

    var searchData = await new Promise(function(resolve, reject) {
      https.get(options, function(response) {
        var body = '';
        response.on('data', function(chunk) { body += chunk; });
        response.on('end', function() {
          try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
        });
      }).on('error', function(err) { console.error('[Кинопоиск] Ошибка запроса:', err.message); resolve(null); });
    });

    if (searchData && searchData.films && searchData.films.length > 0) {
      var movies = searchData.films.slice(0, 5).map(function(f) {
        var genres = f.genres && f.genres.length > 0 ? f.genres[0].genre : '';
        var duration = f.filmLength ? parseInt(f.filmLength) : 0;
        return {
          title: f.nameRu || f.nameEn || f.nameOriginal || '',
          original_title: f.nameOriginal || f.nameEn || '',
          year: f.year || '—',
          poster_url: f.posterUrlPreview || f.posterUrl || null,
          overview: f.description || '',
          rating: f.rating && f.rating !== 'null' ? parseFloat(f.rating) : 0,
          director: '',
          genre: genres,
          duration: duration,
          kp_id: f.filmId,
        };
      });

      // Получаем детали (режиссёр, длительность) для первых 5
      for (var i = 0; i < movies.length; i++) {
        if (movies[i].kp_id) {
          try {
            var detailOptions = {
              hostname: 'kinopoiskapiunofficial.tech',
              path: '/api/v2.2/films/' + movies[i].kp_id,
              headers: { 'X-API-KEY': KP_KEY, 'Content-Type': 'application/json' }
            };
            var detail = await new Promise(function(resolve, reject) {
              https.get(detailOptions, function(response) {
                var body = '';
                response.on('data', function(chunk) { body += chunk; });
                response.on('end', function() {
                  try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
                });
              }).on('error', function() { resolve(null); });
            });
            if (detail) {
              if (detail.filmLength) movies[i].duration = detail.filmLength;
              if (detail.description) movies[i].overview = detail.description.substring(0, 200);
              if (detail.posterUrl) movies[i].poster_url = detail.posterUrl;
              if (detail.genres && detail.genres.length > 0) movies[i].genre = detail.genres[0].genre;
            }
          } catch(e) {}
        }
        // Получаем режиссёра
        if (movies[i].kp_id) {
          try {
            var staffOptions = {
              hostname: 'kinopoiskapiunofficial.tech',
              path: '/api/v1/staff?filmId=' + movies[i].kp_id,
              headers: { 'X-API-KEY': KP_KEY, 'Content-Type': 'application/json' }
            };
            var staff = await new Promise(function(resolve, reject) {
              https.get(staffOptions, function(response) {
                var body = '';
                response.on('data', function(chunk) { body += chunk; });
                response.on('end', function() {
                  try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
                });
              }).on('error', function() { resolve(null); });
            });
            if (staff && Array.isArray(staff)) {
              var director = staff.find(function(s) { return s.professionKey === 'DIRECTOR'; });
              if (director) {
                movies[i].director = director.nameRu || director.nameEn || '';
              }
            }
          } catch(e) {}
        }
        delete movies[i].kp_id;
      }

      console.log('[Кинопоиск] Найдено результатов:', movies.length);
      res.json(movies);
    } else {
      console.log('[Кинопоиск] Ничего не найдено для:', query);
      res.json([]);
    }
  } catch (err) {
    console.error('[Кинопоиск] ОШИБКА:', err.message);
    res.json([]);
  }
});

// ======================== СЕАНСЫ (PostgreSQL JOIN) ========================

app.get('/api/sessions', async function(req, res) {
  try {
    console.log('[PostgreSQL] SELECT с JOIN: sessions + movies + halls + подзапрос GROUP BY (tickets)');
    var sql = [
      'SELECT s.id AS session_id, s.start_time, s.price,',
      '  m.id AS movie_id, m.title AS movie_title, m.genre, m.duration_min, m.poster_url,',
      '  h.id AS hall_id, h.name AS hall_name, h.capacity, h.hall_type,',
      '  h.capacity - COALESCE(t.sold, 0) AS available_seats',
      'FROM sessions s',
      'JOIN movies m ON s.movie_id = m.id',
      'JOIN halls h ON s.hall_id = h.id',
      'LEFT JOIN (SELECT session_id, COUNT(*) AS sold FROM tickets GROUP BY session_id) t ON s.id = t.session_id',
      'WHERE s.start_time > NOW()',
      'ORDER BY s.start_time'
    ].join('\n');
    var result = await pgPool.query(sql);
    console.log('[PostgreSQL] Найдено сеансов:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies/:id/sessions', async function(req, res) {
  try {
    console.log('[PostgreSQL] SELECT сеансы для фильма id =', req.params.id, '(JOIN halls + подзапрос tickets)');
    var sql = [
      'SELECT s.id AS session_id, s.start_time, s.price,',
      '  h.name AS hall_name, h.hall_type, h.capacity,',
      '  h.capacity - COALESCE(t.sold, 0) AS available_seats',
      'FROM sessions s',
      'JOIN halls h ON s.hall_id = h.id',
      'LEFT JOIN (SELECT session_id, COUNT(*) AS sold FROM tickets GROUP BY session_id) t ON s.id = t.session_id',
      'WHERE s.movie_id = $1 AND s.start_time > NOW()',
      'ORDER BY s.start_time'
    ].join('\n');
    var result = await pgPool.query(sql, [req.params.id]);
    console.log('[PostgreSQL] Найдено сеансов:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================== БИЛЕТЫ (PostgreSQL) ========================

app.post('/api/tickets', async function(req, res) {
  var session_id = req.body.session_id;
  var seat_number = req.body.seat_number;
  var customer_name = req.body.customer_name;
  var customer_email = req.body.customer_email;
  if (!session_id || !seat_number || !customer_name || !customer_email)
    return res.status(400).json({ error: 'Все поля обязательны' });
  try {
    console.log('[PostgreSQL] INSERT INTO tickets — сеанс:', session_id, 'место:', seat_number, 'покупатель:', customer_name);
    var result = await pgPool.query(
      'INSERT INTO tickets (session_id, seat_number, customer_name, customer_email) VALUES ($1, $2, $3, $4) RETURNING *',
      [session_id, seat_number, customer_name, customer_email]
    );
    console.log('[PostgreSQL] Билет #' + result.rows[0].id + ' оформлен');
    if (redisClient && redisClient.isOpen) {
      await redisClient.del('stats:tickets_by_movie').catch(function() {});
      console.log('[Redis] Кеш stats:tickets_by_movie инвалидирован после покупки');
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Это место уже занято' });
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================== ЗАЛЫ (PostgreSQL) ========================

app.get('/api/halls', async function(req, res) {
  try {
    var result = await pgPool.query('SELECT * FROM halls ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================== СТАТИСТИКА (PostgreSQL GROUP BY + Redis) ========================

app.get('/api/stats/tickets-by-movie', async function(req, res) {
  try {
    if (redisClient && redisClient.isOpen) {
      var cached = await redisClient.get('stats:tickets_by_movie').catch(function() { return null; });
      if (cached) {
        console.log('[Redis] GET stats:tickets_by_movie — отдаём из кеша');
        return res.json({ source: 'redis-cache', data: JSON.parse(cached) });
      }
    }
    console.log('[PostgreSQL] SELECT с JOIN + GROUP BY: статистика продаж по фильмам');
    var sql = [
      'SELECT m.title, m.genre, COUNT(t.id) AS tickets_sold,',
      '  SUM(s.price) AS total_revenue, ROUND(AVG(s.price), 2) AS avg_price',
      'FROM tickets t',
      'JOIN sessions s ON t.session_id = s.id',
      'JOIN movies m ON s.movie_id = m.id',
      'GROUP BY m.id, m.title, m.genre',
      'ORDER BY tickets_sold DESC'
    ].join('\n');
    var result = await pgPool.query(sql);
    console.log('[PostgreSQL] Результат: ' + result.rows.length + ' фильмов со статистикой');
    if (redisClient && redisClient.isOpen) {
      await redisClient.setEx('stats:tickets_by_movie', 5, JSON.stringify(result.rows)).catch(function() {});
      console.log('[Redis] SETEX stats:tickets_by_movie TTL=5s — закешировано');
    }
    res.json({ source: 'postgresql', data: result.rows });
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats/sessions-by-hall', async function(req, res) {
  try {
    if (redisClient && redisClient.isOpen) {
      var cached = await redisClient.get('stats:sessions_by_hall').catch(function() { return null; });
      if (cached) {
        console.log('[Redis] GET stats:sessions_by_hall — отдаём из кеша');
        return res.json({ source: 'redis-cache', data: JSON.parse(cached) });
      }
    }
    console.log('[PostgreSQL] SELECT с LEFT JOIN + GROUP BY: статистика по залам');
    var sql = [
      'SELECT h.name AS hall_name, h.hall_type, h.capacity,',
      '  COUNT(DISTINCT s.id) AS total_sessions, COUNT(t.id) AS total_tickets,',
      '  ROUND(COUNT(t.id)::NUMERIC / NULLIF(COUNT(DISTINCT s.id), 0), 1) AS avg_tickets_per_session',
      'FROM halls h',
      'LEFT JOIN sessions s ON h.id = s.hall_id',
      'LEFT JOIN tickets t ON s.id = t.session_id',
      'GROUP BY h.id, h.name, h.hall_type, h.capacity',
      'ORDER BY total_sessions DESC, h.id'
    ].join('\n');
    var result = await pgPool.query(sql);
    console.log('[PostgreSQL] Результат: ' + result.rows.length + ' залов');
    if (redisClient && redisClient.isOpen) {
      await redisClient.setEx('stats:sessions_by_hall', 5, JSON.stringify(result.rows)).catch(function() {});
      console.log('[Redis] SETEX stats:sessions_by_hall TTL=5s — закешировано');
    }
    res.json({ source: 'postgresql', data: result.rows });
  } catch (err) {
    console.error('[PostgreSQL] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================== ОТЗЫВЫ (MongoDB) ========================

app.get('/api/reviews', async function(req, res) {
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    var filter = {};
    if (req.query.movie_id) filter.movie_id = parseInt(req.query.movie_id);
    if (req.query.author) filter.author = req.query.author;
    console.log('[MongoDB] db.reviews.find(' + JSON.stringify(filter) + ')');
    var reviews = await mongoDB.collection('reviews').find(filter).sort({ created_at: -1 }).toArray();
    console.log('[MongoDB] Найдено отзывов:', reviews.length);
    res.json(reviews);
  } catch (err) {
    console.error('[MongoDB] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reviews', async function(req, res) {
  var movie_id = req.body.movie_id;
  var movie_title = req.body.movie_title;
  var author = req.body.author;
  var rating = parseInt(req.body.rating);
  var text = req.body.text || '';
  if (!movie_id || !movie_title || !author || !rating)
    return res.status(400).json({ error: 'Укажите фильм, никнейм и оценку' });
  if (rating < 1 || rating > 10)
    return res.status(400).json({ error: 'Оценка должна быть от 1 до 10' });
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    var review = { movie_id: parseInt(movie_id), movie_title: movie_title, author: author, rating: parseInt(rating), text: text, created_at: new Date(), likes: 0 };
    console.log('[MongoDB] db.reviews.insertOne — автор:', author, 'фильм:', movie_title, 'оценка:', rating);
    var result = await mongoDB.collection('reviews').insertOne(review);
    review._id = result.insertedId;
    console.log('[MongoDB] Отзыв добавлен, id:', result.insertedId);
    res.status(201).json(review);
  } catch (err) {
    console.error('[MongoDB] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reviews/stats', async function(req, res) {
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    console.log('[MongoDB] db.reviews.aggregate — $group по movie_id, $avg rating, $sum likes');
    var stats = await mongoDB.collection('reviews').aggregate([
      { $group: { _id: { movie_id: '$movie_id', movie_title: '$movie_title' }, avg_rating: { $avg: '$rating' }, total_reviews: { $sum: 1 }, total_likes: { $sum: '$likes' }, max_rating: { $max: '$rating' }, min_rating: { $min: '$rating' } } },
      { $project: { _id: 0, movie_id: '$_id.movie_id', movie_title: '$_id.movie_title', avg_rating: { $round: ['$avg_rating', 1] }, total_reviews: 1, total_likes: 1, max_rating: 1, min_rating: 1 } },
      { $sort: { avg_rating: -1 } }
    ]).toArray();
    console.log('[MongoDB] Агрегация завершена, фильмов с отзывами:', stats.length);
    res.json(stats);
  } catch (err) {
    console.error('[MongoDB] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================== ПОЛЬЗОВАТЕЛИ (MongoDB) ========================

app.get('/api/users', async function(req, res) {
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    var users = await mongoDB.collection('users').find({}).sort({ visit_count: -1 }).toArray();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================== REDIS CACHE INFO ========================

app.get('/api/cache/info', async function(req, res) {
  try {
    if (!redisClient || !redisClient.isOpen) {
      return res.json({ keys: [
        { key: 'stats:tickets_by_movie', exists: false, ttl: -2 },
        { key: 'stats:sessions_by_hall', exists: false, ttl: -2 },
      ]});
    }
    var ttl1 = await redisClient.ttl('stats:tickets_by_movie');
    var ttl2 = await redisClient.ttl('stats:sessions_by_hall');
    var exists1 = await redisClient.exists('stats:tickets_by_movie');
    var exists2 = await redisClient.exists('stats:sessions_by_hall');
    res.json({ keys: [
      { key: 'stats:tickets_by_movie', exists: !!exists1, ttl: ttl1 },
      { key: 'stats:sessions_by_hall', exists: !!exists2, ttl: ttl2 },
    ]});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cache', async function(req, res) {
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.del('stats:tickets_by_movie');
      await redisClient.del('stats:sessions_by_hall');
      console.log('[Redis] Кеш очищен вручную');
    }
    res.json({ message: 'Кеш очищен' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================== АВТОРИЗАЦИЯ (MongoDB) ========================

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/api/auth/register', async function(req, res) {
  var username = req.body.username;
  var full_name = req.body.full_name;
  var email = req.body.email;
  var password = req.body.password;
  var preferences = req.body.preferences || { genres: [], preferred_hall: 'Стандарт' };
  if (!username || !full_name || !email || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Пароль должен быть не менее 4 символов' });
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    var existing = await mongoDB.collection('users').findOne({ $or: [{ email: email }, { username: username }] });
    if (existing) {
      if (existing.email === email) return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
      return res.status(409).json({ error: 'Никнейм уже занят' });
    }
    var user = {
      username: username, email: email, full_name: full_name,
      password_hash: hashPassword(password),
      registered_at: new Date(),
      preferences: preferences,
      visit_count: 1,
    };
    console.log('[MongoDB] db.users.insertOne — регистрация:', username);
    var result = await mongoDB.collection('users').insertOne(user);
    user._id = result.insertedId;
    console.log('[MongoDB] Пользователь зарегистрирован:', username);
    var safeUser = { _id: user._id, username: user.username, email: user.email,
      full_name: user.full_name, registered_at: user.registered_at,
      preferences: user.preferences, visit_count: user.visit_count };
    res.status(201).json({ user: safeUser });
  } catch (err) {
    console.error('[MongoDB] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  if (!email || !password)
    return res.status(400).json({ error: 'Введите email и пароль' });
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    console.log('[MongoDB] db.users.findOne — вход:', email);
    var user = await mongoDB.collection('users').findOne({ email: email });
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (user.password_hash !== hashPassword(password))
      return res.status(401).json({ error: 'Неверный пароль' });
    console.log('[MongoDB] Вход выполнен:', user.username);
    var safeUser = { _id: user._id, username: user.username, email: user.email,
      full_name: user.full_name, registered_at: user.registered_at,
      preferences: user.preferences, visit_count: user.visit_count };
    res.json({ user: safeUser });
  } catch (err) {
    console.error('[MongoDB] ОШИБКА:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Трекинг визитов
app.post('/api/users/:username/visit', async function(req, res) {
  try {
    if (!mongoDB) return res.status(503).json({ error: 'MongoDB недоступна' });
    var result = await mongoDB.collection('users').findOneAndUpdate(
      { username: req.params.username },
      { $inc: { visit_count: 1 } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ visit_count: result.visit_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================== ЗАПУСК ========================

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

async function start() {
  try {
    await connectDatabases();
    app.listen(PORT, function() {
      console.log('\n=== Сервер кинотеатра запущен: http://localhost:' + PORT + ' ===');
      console.log('Статус БД:', JSON.stringify(dbStatus));
      console.log('');
    });
  } catch (err) { console.error('Ошибка запуска:', err.message); process.exit(1); }
}

start();