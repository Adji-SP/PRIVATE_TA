// server.js

// === 1. IMPORTS UTAMA ===
// Mengimpor semua modul yang diperlukan
const express = require('express');
const mqtt = require('mqtt'); 
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const util = require('util'); //
const cors = require('cors'); 
const path = require('path');



const app = express();
app.use(cors());
const port = 3000; // Port untuk server API
app.use(bodyParser.json()); // Middleware untuk mengurai JSON body dari request HTTP

// === 2. KONFIGURASI AZURE DATABASE & RECONNECT LOGIC ===
const dbConfig = {
    // Detail koneksi Azure MySQL Anda yang sudah teruji
    host: 'simulatorserver.mysql.database.azure.com',
    user: 'auliazqi', // Kritis: Ditemukan format ini yang berhasil di Azure Flexible Server
    password: 'Admin123',
    database: 'simulator_db',
    ssl: { rejectUnauthorized: false } // WAJIB untuk Azure tanpa file CA };
};
let dbConnection; 
// DEKLARASIKAN QUERY DENGAN PROMISIFY
let queryPromise; // <-- VARIABEL BARU

// Fungsi untuk membuat dan mengelola koneksi ulang ke database
function handleDisconnect() {
dbConnection = mysql.createConnection(dbConfig);
queryPromise = util.promisify(dbConnection.query).bind(dbConnection); // <-- KOREKSI 2: PROMISIFY WAJIB!

    dbConnection.connect(err => {
        if (err) {
            console.error('❌ Gagal connect ke Azure DB (Mencoba Ulang):', err.message);
            setTimeout(handleDisconnect, 2000); // Coba koneksi ulang setelah 2 detik
        } else {
            console.log('✅ Terkoneksi ke Azure Database.');
        }
    });
    // Listener untuk mendeteksi putus koneksi (ECONNRESET/Fatal Error)
    dbConnection.on('error', err => {
        if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
            console.error('⚠️ Koneksi DB Terputus. Memulai Koneksi Ulang...');
            handleDisconnect();
        } else {
            throw err;
        }
    });
}
handleDisconnect(); // Panggil fungsi saat server startup

// FUNGSI PENGUJIAN QUERY (WAJIB)
function testDbConnection() {
    queryPromise('SELECT id, username FROM users LIMIT 1')
        .then(results => {
            console.log(`✅ Uji Query Sukses! User pertama: ${results[0] ? results[0].username : 'Tidak ada user'}`);
        })
        .catch(error => {
            // JIKA INI GAGAL, MAKA SIGN UP PASTI GAGAL
            console.error('❌ UJI QUERY GAGAL! ERRORNYA ADA PADA SQL/KOLOM:', error.sqlMessage || error.message);
        });
}

// === 3. KONFIGURASI HIVEMQ CLOUD (MQTT BROKER) ===
const mqttBrokerHost = 'daeb68cee1a0470ab4fbd5a4f1691fe8.s1.eu.hivemq.cloud';
const mqttBrokerPort = 8883; // Port untuk koneksi aman (TLS/SSL)

const mqttOptions = {
    host: mqttBrokerHost, port: mqttBrokerPort, protocol: 'mqtts',
    username: 'auliazqi',
    password: 'Serveradmin123', // Kritis: Password HiveMQ yang sudah disinkronkan
    clientId: 'nodejs_backend_client_' + Math.random().toString(16).substr(2, 8), // Client ID unik
    rejectUnauthorized: false
};

const client = mqtt.connect(mqttOptions);

client.on('connect', () => {
    console.log(`✅ Terkoneksi ke HiveMQ Cloud: ${mqttBrokerHost}`);
    console.log('✅ Backend Connected to MQTT Broker!');

    // 1. Subscribe ke Data Temperature (Plant)
    client.subscribe('plant/data/#', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: plant/data/# (Temperature)`);
        }
    });

    // 2. Subscribe ke Data Pressure (SIS) 
    client.subscribe('sis/data/#', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: sis/data/# (Pressure)`);
        }
    });

    // 3. Subscribe ke Control Admin
    client.subscribe('admin/control/#', (err) => {
        if (!err) {
            console.log(`✅ Subscribed to: admin/control/# (Perintah Kontrol)`);
        }
    });
});

// --- 4. PENANGANAN DATA MASUK (MQTT MESSAGE) ---
// Deklarasikan variabel global untuk melacak data terakhir yang diterima
lastInsertedId = null;

client.on('message', (topic, message) => {
    try {
        const sensorData = JSON.parse(message.toString());

        // Ekstraksi nilai sensor dan timestamp yang diterima dari ESP32
        const sendTimestamp = sensorData.send_timestamp;
        let sensorValue = null;
        let columnName = null;
	let extraData = {};
        
        // KASUS 1: TEMPERATURE (Tetap di plant/data)
        if (topic === 'plant/data/temperature') {
            sensorValue = sensorData.temperature;
            columnName = 'temperature';
        let voltageVal = sensorData.voltage !== undefined ? sensorData.voltage : 0;

    	extraData = {
        	voltage: voltageVal // Masukkan ke wadah agar terbawa ke database
    	};
        // KASUS 2: PRESSURE (Berubah ke sis/data)
        } else if (topic === 'sis/data/pressure') { 
            sensorValue = sensorData.pressure;
            columnName = 'pressure';
	    let voltageVal = sensorData.voltage !== undefined ? sensorData.voltage : 0;
	    extraData = {
            sv1: sensorData.sv1,     
            sv2: sensorData.sv2,
            buzzer: sensorData.buzzer,
	    voltage: voltageVal
            };
            
        } else {
            // Abaikan jika topik tidak dikenali (misal topic control)
            return;
        }

        console.log(`[DATA] Menerima ${columnName}: ${sensorValue}, Extra:`, extraData);

        // --- Mulai Logika UPDATE/INSERT ---
        handleDbUpdate(columnName, sensorValue, sendTimestamp, extraData);

    } catch (e) {
        console.error('❌ Error parsing JSON atau logic MQTT:', e.message);
    }
});


// --- 4. PENANGANAN DATA MASUK (MQTT MESSAGE) ---
// Deklarasikan variabel global untuk melacak data terakhir yang diterima
//Fungsi untuk menangani INSERT atau UPDATE (FINAL LOGIC)
function handleDbUpdate(columnName, sensorValue, sendTimestamp, extraData = {}) {
    // Ambil nilai sv1/sv2 dari extraData. Jika tidak ada, baru pakai 0.
    const sv1 = extraData.sv1 !== undefined ? extraData.sv1 : 0;
    const sv2 = extraData.sv2 !== undefined ? extraData.sv2 : 0;
    const buzzer = extraData.buzzer !== undefined ? extraData.buzzer : 0;
    const voltage = extraData.voltage !== undefined ? extraData.voltage : 0
    // 1. UPDATE (Jika baris terakhir masih kosong kolomnya)
    let updateQuery = '';
    let updateValues = [];

    if (columnName === 'pressure') {
        // Update Pressure SEKALIGUS status Valve
        updateQuery = `
            UPDATE sensor_data
            SET ${columnName} = ?, sv1_status = ?, sv2_status = ?, buzzer_status = ?, voltage_pressure = ?, send_timestamp = ?, receive_timestamp = NOW()
            WHERE id = ? AND ${columnName} IS NULL;
        `;
        updateValues = [sensorValue, sv1, sv2, buzzer, voltage, sendTimestamp, lastInsertedId];
    } else {
        // Update Temperature (Logic lama)
        updateQuery = `
            UPDATE sensor_data
            SET ${columnName} = ?, send_timestamp = ?, receive_timestamp = NOW()
            WHERE id = ? AND ${columnName} IS NULL;
        `;
        updateValues = [sensorValue, sendTimestamp, lastInsertedId];
    }

    // Eksekusi UPDATE
    dbConnection.query(updateQuery, updateValues, (err, result) => {
        if (err) { console.error('❌ Error UPDATE DB:', err.message); return; }

        if (result.affectedRows > 0) {
            console.log(`✅ UPDATE Data Masuk ke ID: ${lastInsertedId}`);
            return;
        }

        // 2. INSERT BARU (Jika Update Gagal/Baris Penuh)
        // PERHATIKAN: Di sini kita pakai variabel sv1 & sv2, BUKAN ANGKA 0 LAGI
        const insertQuery = `
           INSERT INTO sensor_data (temperature, pressure, relay_status, sv1_status, sv2_status, buzzer_status, voltage_temp, voltage_pressure, send_timestamp, receive_timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW());
        `;

        let insertValues = [];
        if (columnName === 'temperature') {
            // Urutan : Temp, Press, SV1, SV2, Buzzer, Volt_Temp, Volt_Press, Send_Timestamp, Receive_Timestamp
            // Kita masukkan data 'voltage' ke kolom 'voltage_temp'
            insertValues = [sensorValue, null, 0, 0, 0, 0, voltage, null, sendTimestamp]; 
        } else {
            // PRESSURE: Masukkan data 'voltage' ke kolom 'voltage_pressure'
            insertValues = [null, sensorValue, 0, sv1, sv2, buzzer, null, voltage, sendTimestamp];
        }

        dbConnection.query(insertQuery, insertValues, (err, result) => {
            if (err) { console.error('❌ Error INSERT DB:', err.message); return; }
            lastInsertedId = result.insertId;
            console.log(`⭐ INSERT BARU (ID: ${lastInsertedId}) -> Pressure: ${sensorValue}, SV1: ${sv1}, SV2: ${sv2}`);
        });
    });
}

// ==============================================
// 5. ENDPOINTS API (FUNGSI KONTROL & OTENTIKASI)
// ==============================================
/// server.js: [A] Endpoint API untuk Sign Up (DEBUGGING TANPA HASHING)

app.post('/api/signup', async (req, res) => { // <-- KOREKSI 3A: TAMBAH async
    try {
    const { username, email, phone, password } = req.body;
    
   // --- BCRYPT DIHIDUPKAN KEMBALI ---
        const hash = await bcrypt.hash(password, 10); // <-- KOREKSI 3B: BCRYPT ASYNC
        // --- BCRYPT DIHIDUPKAN KEMBALI ---

    // QUERY MENGGUNAKAN NAMA KOLOM YANG SUDAH ANDA KONFIRMASI
        const query = 'INSERT INTO users (username, email, phone, password, role) VALUES (?, ?, ?, ?, ?)'; 
        
        // KOREKSI 3C: GUNAKAN await queryPromise
        const result = await queryPromise(query, [username, email, phone, hash, 'user']);
        
        console.log(`✅ User ${username} berhasil didaftarkan.`);
        res.status(201).json({ success: true, message: 'Akun berhasil dibuat.' });
        
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Username atau Email sudah terdaftar.' });
        }
        // *** INI ADALAH LOG UTAMA KITA ***
        console.error('❌ FINAL DB ERROR (Sign Up):', err.sqlMessage || err.message); 
        return res.status(500).json({ success: false, message: 'Server error saat pendaftaran.' });
    }
});

// [B] Endpoint API untuk Login (KOREKSI)
// server.js: [B] Endpoint API untuk Login (KODE YANG BENAR DAN STABIL)

app.post('/api/login', async (req, res) => { // <-- KOREKSI 4A: TAMBAH async
    try {
    const { email, password } = req.body;
    
    // Pastikan 5 kolom diambil
    const query = 'SELECT id, username, email, phone, password, role FROM users WHERE email = ?'; 

    // KOREKSI 4B: GUNAKAN await queryPromise
        const results = await queryPromise(query, [email]); 
        
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: 'Email tidak terdaftar.' });
        }
        
        const user = results[0];
        const hashedPassword = user.password;

        // KOREKSI 4C: BCRYPT ASYNC
        const isMatch = await bcrypt.compare(password, hashedPassword); 

        if (isMatch) {
            // Login berhasil
            const userData = { id: user.id, username: user.username, email: user.email, role: user.role };
            console.log(`✅ Login berhasil untuk user: ${user.username}`);
            res.json({ success: true, user: userData, message: 'Login berhasil!' });
        } else {
            return res.status(401).json({ success: false, message: 'Password salah.' });
        }
    } catch (err) {
        console.error('❌ FINAL DB ERROR (Login):', err.sqlMessage || err.message);
        return res.status(500).json({ success: false, message: 'Server error saat login.' });
    }
});

/// [C] Endpoint API untuk mendapatkan data terbaru (KOREKSI FINAL)
app.get('/api/latest-data', async (req, res) => { // <<< TAMBAH async
    // Dipanggil oleh frontend untuk polling data real-time
    const query = 'SELECT * FROM sensor_data ORDER BY receive_timestamp DESC LIMIT 1';
    
    try {
        // GANTI dbConnection.query DENGAN await queryPromise
        const result = await queryPromise(query); // <<< WAJIB GUNAKAN queryPromise
        
        // Cek jika ada hasil, jika tidak kirim objek kosong
        res.json(result.length > 0 ? result[0] : {}); 
        
    } catch (err) {
        // Log error secara detail di console backend
        console.error('❌ FATAL ERROR DI /api/latest-data:', err.sqlMessage || err.message);
        // Kirim 500 ke frontend
        res.status(500).send('Gagal mengambil data dari server database.');
    }
});

// [D] ENDPOINT API UNTUK SETPOINT SUHU/KP/SAMPLING (MENU 1)
app.post('/api/control/setpoint/:param', (req, res) => {
    const param = req.params.param; // parameter yang dikirim (temp, sampling, kp)
    const value = req.body.value;
    
    console.log(`[REQUEST RECEIVED] API Control hit: ${param} = ${value}`); 

    if (isNaN(value)) { return res.status(400).send({ success: false, message: 'Nilai tidak valid.' }); }

    const payload = { parameter: param, value: value, timestamp: Date.now() };
    
    // PUBLISH ke MQTT (Topic: admin/control/setpoints)
    client.publish('admin/control/setpoints', JSON.stringify(payload), (err) => {
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL SUCCESS] Setpoint ${param} dikirim: ${value}`);
        res.send({ success: true, message: `Setpoint ${param} berhasil dikirim.` });
    });
});

// [E] ENDPOINT API UNTUK BATAS TEKANAN (PAH/PAHH - MENU 2)
app.post('/api/control/pressure-limit/:param', (req, res) => {
    const param = req.params.param; 
    const value = req.body.value;
    
    if (isNaN(value)) { return res.status(400).send({ success: false, message: 'Nilai tekanan tidak valid.' }); }

    const payload = { parameter: `pressure_${param}`, value: value, timestamp: Date.now() };
    
    client.publish('admin/control/setpoints', JSON.stringify(payload), (err) => { // Menggunakan topic yang sama
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL] Batas Tekanan ${param} dikirim: ${value}`);
        res.send({ success: true, message: `Batas Tekanan ${param} berhasil dikirim.` });
    });
});

// [F] ENDPOINT API UNTUK TOGGLE VALVE (SV1/SV2 - MENU 2)
app.post('/api/control/valve/:valveId', (req, res) => {
    const valveId = req.params.valveId;
    const status = req.body.status;
    
    const payload = { command: 'valve_toggle', valve: valveId, status: status, timestamp: Date.now() };
    
    client.publish('admin/control/valve', JSON.stringify(payload), (err) => { // Topic khusus untuk valve
        if (err) { return res.status(500).send({ success: false, message: 'Gagal kirim via MQTT.' }); }
        console.log(`[CONTROL] Valve ${valveId} disetel ke: ${status}`);
        res.send({ success: true, message: `Valve ${valveId} disetel ke ${status ? 'ON' : 'OFF'}.` });
    });
});

// [F.2] ENDPOINT API UNTUK SIS SIMULATION TOGGLE (ON/OFF)
app.post('/api/sis-control', (req, res) => {
    // 1. Ambil status dari Frontend ("ON" atau "OFF")
    const { status } = req.body; 

    console.log(`[REQUEST RECEIVED] API SIS Control hit: Status = ${status}`);

    // Validasi input
    if (status !== 'ON' && status !== 'OFF') { 
        return res.status(400).json({ success: false, message: 'Status tidak valid. Harus ON atau OFF.' }); 
    }

    // 2. Siapkan Payload JSON untuk dikirim ke ESP32
    // Format kita samakan dengan style project Anda
    const payload = { 
        command: 'SET_SIS_MODE', 
        status: status, // "ON" atau "OFF"
        timestamp: Date.now() 
    };

    // 3. Tentukan Topik MQTT
    // Kita buat topik khusus agar tidak bentrok dengan valve atau setpoint
    const topic = 'admin/control/sis';

    // 4. Publish ke MQTT
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) { 
            console.error('[MQTT ERROR] Gagal publish SIS Control:', err);
            return res.status(500).json({ success: false, message: 'Gagal kirim perintah ke MQTT.' }); 
        }

        console.log(`[CONTROL SUCCESS] Perintah SIS dikirim ke topik '${topic}': ${status}`);
        
        // 5. Balas ke Frontend
        res.json({ 
            success: true, 
            message: `Sistem berhasil di-set ke ${status}` 
        });
    });
});

// server.js (Tambahkan di bagian API Endpoints)

// Fungsi utilitas untuk konversi array JSON ke CSV string
const jsonToCsv = (data, headerColumns) => {
    if (!data || data.length === 0) return headerColumns.join(',') + '\n';
    
    const header = headerColumns.join(',') + '\n';
    const rows = data.map(obj => 
        headerColumns.map(col => {
            // Tangani nilai null atau undefined
            const value = (obj[col] !== null && obj[col] !== undefined) ? obj[col] : '';
            // Pastikan nilai yang mengandung koma dibungkus quotes (opsional)
            return (typeof value === 'string' && value.includes(',')) ? `"${value}"` : value;
        }).join(',')
    ).join('\n');
    
    return header + rows;
};

// [G] ENDPOINT API UNTUK EXPORT SUHU (MENU 1)
app.get('/api/export/temperature-log', async (req, res) => {
    try {
        // 1. Tangkap parameter start & end dari Frontend
        const { start, end } = req.query; 
        
        const header = ['id', 'temperature', 'sv1_status', 'receive_timestamp'];
        let query = '';
        let params = [];

        // 2. Logika Pemilihan Query
        if (start && end) {
            // JIKA ADA WAKTU RECORD: Ambil data DIANTARA waktu start & end
            console.log(`[EXPORT TEMP] Request Range: ${start} s/d ${end}`);
            query = 'SELECT id, temperature, sv1_status, receive_timestamp FROM sensor_data WHERE temperature IS NOT NULL AND receive_timestamp BETWEEN ? AND ? ORDER BY receive_timestamp ASC';
            params = [start, end];
        } else {
            // JIKA TIDAK ADA (Default): Ambil 500 data terakhir
            console.log(`[EXPORT TEMP] Request Default (500 limit)`);
            query = 'SELECT id, temperature, sv1_status, receive_timestamp FROM sensor_data WHERE temperature IS NOT NULL ORDER BY receive_timestamp DESC LIMIT 500';
        }

        const results = await queryPromise(query, params);
        const csv = jsonToCsv(results, header);

        res.header('Content-Type', 'text/csv');
        res.attachment(`Temperature_Log.csv`);
        res.send(csv);

    } catch (err) {
        console.error('❌ Error Export Temp:', err);
        res.status(500).send('Server Error');
    }
});

// [H] ENDPOINT API UNTUK EXPORT TEKANAN (MENU 2)
app.get('/api/export/pressure-log', async (req, res) => {
    try {
        // 1. Tangkap parameter start & end
        const { start, end } = req.query;
        
        const header = ['id', 'pressure', 'sv1_status', 'sv2_status', 'buzzer_status', 'receive_timestamp'];
        let query = '';
        let params = [];

        // 2. Logika Pemilihan Query
        if (start && end) {
            console.log(`[EXPORT PRESSURE] Request Range: ${start} s/d ${end}`);
            query = 'SELECT id, pressure, sv1_status, sv2_status, buzzer_status, receive_timestamp FROM sensor_data WHERE pressure IS NOT NULL AND receive_timestamp BETWEEN ? AND ? ORDER BY receive_timestamp ASC';
            params = [start, end];
        } else {
            console.log(`[EXPORT PRESSURE] Request Default (500 limit)`);
            query = 'SELECT id, pressure, sv1_status, sv2_status, buzzer_status, receive_timestamp FROM sensor_data WHERE pressure IS NOT NULL ORDER BY receive_timestamp DESC LIMIT 500';
        }

        const results = await queryPromise(query, params);
        const csv = jsonToCsv(results, header);

        res.header('Content-Type', 'text/csv');
        res.attachment(`Pressure_Log.csv`);
        res.send(csv);

    } catch (err) {
        console.error('❌ Error Export Pressure:', err);
        res.status(500).send('Server Error');
    }
});

const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath, { index: false }));

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'auth.html'));
});
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ msg: 'API Not Found' });
    res.sendFile(path.join(frontendPath, 'auth.html'));
});

// --- 6. START SERVER ---
app.listen(port, () => {
    console.log(`Server backend berjalan di http://localhost:${port}`);
}); 
