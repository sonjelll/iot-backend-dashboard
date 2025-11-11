import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import mysql from 'mysql2/promise';
import mqtt from 'mqtt';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 10
});

const HTTP_PORT = process.env.HTTP_PORT || 3000;

// ========= API ENDPOINTS =========

// Tambah data manual
app.post('/api/insert', async (req, res) => {
  try {
    const { suhu, humidity, lux, timestamp } = req.body;
    if (![suhu, humidity, lux].every(v => Number.isFinite(Number(v)))) {
      return res.status(400).json({ error: 'Input harus angka' });
    }
    const sql = `
      INSERT INTO data_sensor (suhu, humidity, lux, timestamp)
      VALUES (?, ?, ?, ?)
    `;
    const ts = timestamp
      ? new Date(timestamp).toISOString().slice(0,19).replace('T',' ')
      : new Date().toISOString().slice(0,19).replace('T',' ');
    const [r] = await pool.query(sql, [suhu, humidity, lux, ts]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ambil data terbaru
app.get('/api/latest', async (req, res) => {
  const n = Math.max(1, Math.min(1000, parseInt(req.query.n || '50', 10)));
  const [rows] = await pool.query(
    'SELECT * FROM data_sensor ORDER BY id ASC LIMIT ?',
    [n]
  );
  res.json(rows);
});


// Summary sesuai format soal
app.get('/api/summary', async (req, res) => {
  const [agg] = await pool.query(`
    SELECT MAX(suhu) AS suhumax,
           MIN(suhu) AS suhmin,
           ROUND(AVG(suhu), 2) AS suhurata
    FROM data_sensor
  `);
  const { suhumax, suhmin, suhurata } = agg[0];

  const [top] = await pool.query(`
    SELECT id AS idx, suhu AS suhun, humidity AS humid, lux AS kecerahan,
           DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp
    FROM data_sensor
    WHERE suhu = (SELECT MAX(suhu) FROM data_sensor)
      AND humidity = (SELECT MAX(humidity) FROM data_sensor)
  `);

  const month_year_max = top.map(r => {
    const [y, m] = r.timestamp.split(' ')[0].split('-');
    return { month_year: `${parseInt(m)}-${y}` };
  });

  res.json({
    suhumax,
    suhmin,
    suhurata,
    nilai_suhu_max_humid_max: top,
    month_year_max
  });
});

// ========= MQTT BRIDGE =========
const mqttClient = mqtt.connect(process.env.MQTT_URL);
mqttClient.on('connect', () => {
  console.log('MQTT connected');
  mqttClient.subscribe('esp32/sensor');
});

mqttClient.on('message', async (topic, payload) => {
  if (topic !== 'esp32/sensor') return;
  try {
    const data = JSON.parse(payload.toString());
    const suhu = Number(data.suhu);
    const humidity = Number(data.humidity);
    const lux = Number(data.lux);
    const timestamp = new Date().toISOString().slice(0,19).replace('T',' ');
    if (![suhu, humidity, lux].every(Number.isFinite)) return;
    await pool.query(
      'INSERT INTO data_sensor (suhu, humidity, lux, timestamp) VALUES (?, ?, ?, ?)',
      [suhu, humidity, lux, timestamp]
    );
    console.log('Inserted from MQTT:', data);
  } catch (e) {
    console.error('MQTT error:', e.message);
  }
});

// Jalankan server
app.listen(HTTP_PORT, () => {
  console.log(`Server running at http://localhost:${HTTP_PORT}`);
});
