var { Client } = require('pg');
var { MongoClient } = require('mongodb');

async function initPostgres() {
  var client = new Client({
    host: 'localhost', port: 5432,
    user: 'postgres', password: 'postgres', database: 'cinema',
  });

  await client.connect();
  console.log('[PostgreSQL] Подключено');

  // Удаляем таблицы
  await client.query('DROP TABLE IF EXISTS tickets CASCADE');
  await client.query('DROP TABLE IF EXISTS sessions CASCADE');
  await client.query('DROP TABLE IF EXISTS movies CASCADE');
  await client.query('DROP TABLE IF EXISTS halls CASCADE');
  console.log('[PostgreSQL] Старые таблицы удалены');

  // Таблица залов
  await client.query(
    'CREATE TABLE halls (' +
    '  id SERIAL PRIMARY KEY,' +
    '  name VARCHAR(100) NOT NULL UNIQUE,' +
    '  capacity INT NOT NULL CHECK (capacity > 0),' +
    '  hall_type VARCHAR(50) NOT NULL DEFAULT \'Стандарт\'' +
    ')'
  );

  // Таблица фильмов
  await client.query(
    'CREATE TABLE movies (' +
    '  id SERIAL PRIMARY KEY,' +
    '  title VARCHAR(200) NOT NULL,' +
    '  genre VARCHAR(100) NOT NULL,' +
    '  duration_min INT NOT NULL CHECK (duration_min > 0),' +
    '  director VARCHAR(150) NOT NULL,' +
    '  description TEXT,' +
    '  rating NUMERIC(3,1) CHECK (rating >= 0 AND rating <= 10),' +
    '  poster_url TEXT' +
    ')'
  );

  // Таблица сеансов
  await client.query(
    'CREATE TABLE sessions (' +
    '  id SERIAL PRIMARY KEY,' +
    '  movie_id INT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,' +
    '  hall_id INT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,' +
    '  start_time TIMESTAMP NOT NULL,' +
    '  price NUMERIC(10,2) NOT NULL CHECK (price > 0),' +
    '  UNIQUE(hall_id, start_time)' +
    ')'
  );

  // Таблица билетов
  await client.query(
    'CREATE TABLE tickets (' +
    '  id SERIAL PRIMARY KEY,' +
    '  session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,' +
    '  seat_number INT NOT NULL CHECK (seat_number > 0),' +
    '  customer_name VARCHAR(150) NOT NULL,' +
    '  customer_email VARCHAR(200) NOT NULL,' +
    '  purchased_at TIMESTAMP NOT NULL DEFAULT NOW(),' +
    '  UNIQUE(session_id, seat_number)' +
    ')'
  );

  console.log('[PostgreSQL] Таблицы созданы: halls, movies, sessions, tickets');

  // Залы кинотеатра
  await client.query(
    "INSERT INTO halls (name, capacity, hall_type) VALUES " +
    "('Зал 1', 120, 'Стандарт'), " +
    "('Зал 2', 80, 'Комфорт'), " +
    "('Зал 3', 200, 'IMAX'), " +
    "('Зал 4', 50, 'VIP')"
  );

  console.log('[PostgreSQL] Добавлено 4 зала');
  await client.end();
}

async function initMongo() {
  var client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  console.log('[MongoDB] Подключено');

  var db = client.db('cinema');

  // Очищаем коллекции
  await db.collection('reviews').drop().catch(function() {});
  await db.collection('users').drop().catch(function() {});

  // Создаём пустые коллекции
  await db.createCollection('users');
  await db.createCollection('reviews');

  console.log('[MongoDB] Коллекции созданы: users (пустая), reviews (пустая)');
  await client.close();
}

(async function() {
  try {
    await initPostgres();
    await initMongo();
    console.log('\n=== Все базы данных инициализированы! ===');
    console.log('Залы созданы. Добавляйте фильмы через сайт.');
    console.log('Зарегистрируйтесь через /auth.html для создания пользователя.');
  } catch (err) {
    console.error('Ошибка инициализации:', err.message);
    process.exit(1);
  }
})();