// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- DB Setup ---
async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appearance (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS race_event (
      id SERIAL PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id SERIAL PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS checkpoint_data (
      id SERIAL PRIMARY KEY,
      runner_id TEXT,
      name TEXT,
      status TEXT,
      checkpoints JSONB,
      last_update BIGINT
    );
    CREATE TABLE IF NOT EXISTS recent_activity (
      id SERIAL PRIMARY KEY,
      timestamp BIGINT,
      html TEXT
    );
  `);
}
setupDb();

// --- Helper functions for DB CRUD ---
async function getAllUsers() {
  const res = await pool.query('SELECT * FROM users');
  return res.rows;
}
async function addUser(user) {
  await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING', [user.username, user.password]);
}
async function removeUser(username) {
  await pool.query('DELETE FROM users WHERE username = $1', [username]);
}
async function getAppearance() {
  const res = await pool.query('SELECT * FROM appearance');
  const obj = {};
  res.rows.forEach(row => { obj[row.key] = row.value; });
  return obj;
}
async function setAppearance(key, value) {
  await pool.query('INSERT INTO appearance (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
}
async function getRaceEventName() {
  const res = await pool.query('SELECT name FROM race_event ORDER BY id DESC LIMIT 1');
  return res.rows[0]?.name || '';
}
async function setRaceEventName(name) {
  await pool.query('INSERT INTO race_event (name) VALUES ($1)', [name]);
}
async function getCheckpoints() {
  const res = await pool.query('SELECT name FROM checkpoints ORDER BY id ASC');
  return res.rows.map(row => row.name);
}
async function setCheckpoints(list) {
  await pool.query('TRUNCATE checkpoints RESTART IDENTITY');
  for (const name of list) {
    await pool.query('INSERT INTO checkpoints (name) VALUES ($1)', [name]);
  }
}
async function getCheckpointData() {
  const res = await pool.query('SELECT * FROM checkpoint_data');
  const obj = {};
  res.rows.forEach(row => {
    obj[row.runner_id] = {
      name: row.name,
      status: row.status,
      checkpoints: row.checkpoints,
      lastUpdate: row.last_update
    };
  });
  return obj;
}
async function setCheckpointData(data) {
  await pool.query('TRUNCATE checkpoint_data RESTART IDENTITY');
  for (const runnerId in data) {
    const d = data[runnerId];
    await pool.query(
      'INSERT INTO checkpoint_data (runner_id, name, status, checkpoints, last_update) VALUES ($1, $2, $3, $4, $5)',
      [runnerId, d.name, d.status, JSON.stringify(d.checkpoints), d.lastUpdate || null]
    );
  }
}
async function getRecentActivity() {
  const res = await pool.query('SELECT * FROM recent_activity ORDER BY timestamp DESC LIMIT 100');
  return res.rows.map(row => ({ timestamp: row.timestamp, html: row.html }));
}
async function addActivity(activity) {
  await pool.query('INSERT INTO recent_activity (timestamp, html) VALUES ($1, $2)', [activity.timestamp, activity.html]);
}
async function resetAllData() {
  await pool.query('TRUNCATE users, appearance, race_event, checkpoints, checkpoint_data, recent_activity RESTART IDENTITY');
}

// --- Socket.IO handlers ---
io.on('connection', async (socket) => {
  // On connect, send all data from DB
  const users = await getAllUsers();
  const appearance = await getAppearance();
  const raceEventName = await getRaceEventName();
  const checkpoints = await getCheckpoints();
  const checkpointData = await getCheckpointData();
  const recentActivity = await getRecentActivity();
  socket.emit('allData', {
    users,
    appearance,
    raceEventName,
    checkpoints,
    checkpointData,
    recentActivity
  });

  socket.on('addUser', async (user) => {
    await addUser(user);
    const users = await getAllUsers();
    io.emit('usersUpdated', users);
  });
  socket.on('removeUser', async (username) => {
    await removeUser(username);
    const users = await getAllUsers();
    io.emit('usersUpdated', users);
  });
  socket.on('updateAppearance', async (data) => {
    for (const key in data) {
      await setAppearance(key, data[key]);
    }
    const appearance = await getAppearance();
    io.emit('appearanceUpdated', appearance);
  });
  socket.on('updateRaceEventName', async (name) => {
    await setRaceEventName(name);
    const raceEventName = await getRaceEventName();
    io.emit('raceEventNameUpdated', raceEventName);
  });
  socket.on('updateCheckpoints', async (list) => {
    await setCheckpoints(list);
    const checkpoints = await getCheckpoints();
    io.emit('checkpointsUpdated', checkpoints);
  });
  socket.on('updateCheckpointData', async (data) => {
    await setCheckpointData(data);
    const checkpointData = await getCheckpointData();
    io.emit('checkpointDataUpdated', checkpointData);
  });
  socket.on('addActivity', async (activity) => {
    await addActivity(activity);
    const recentActivity = await getRecentActivity();
    io.emit('recentActivityUpdated', recentActivity);
  });
});

// --- Reset endpoint (clear all tables except users) ---
app.post('/reset', async (req, res) => {
  await pool.query('TRUNCATE appearance, race_event, checkpoints, checkpoint_data, recent_activity RESTART IDENTITY');
  io.emit('allData', {
    users: await getAllUsers(),
    appearance: {},
    raceEventName: '',
    checkpoints: [],
    checkpointData: {},
    recentActivity: []
  });
  res.send({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
}); 
