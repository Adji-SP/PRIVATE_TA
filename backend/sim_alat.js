const mqtt = require('mqtt');

// --- KONFIGURASI KONEKSI ---
const host = 'daeb68cee1a0470ab4fbd5a4f1691fe8.s1.eu.hivemq.cloud';
const port = '8883';
const protocol = 'mqtts';
const username = 'auliazqi'; 
const password = 'Serveradmin123'; 

const client = mqtt.connect(`${protocol}://${host}:${port}`, {
    username: username,
    password: password,
    rejectUnauthorized: false
});

client.on('connect', () => {
    console.log('🤖 ROBOT SIMULATOR: Terhubung ke MQTT!');
    console.log('🚀 Mulai mengirim data dengan LABEL YANG BENAR...');
    setInterval(kirimDataPalsu, 3000);
});

client.on('error', (err) => {
    console.error('❌ Koneksi Gagal:', err);
});

function kirimDataPalsu() {
    const randomTemp = (Math.random() * (110 - 90) + 90).toFixed(2);
    const randomPressure = (Math.random() * (2.5 - 0.5) + 0.5).toFixed(2);
    const randomVoltage = (Math.random() * 5).toFixed(2);
    const timestamp = Date.now();

    // --- PERBAIKAN DISINI (PENTING!) ---
    // Jangan pakai "value", tapi pakai nama spesifik "temperature" dan "pressure"
    // Agar server tidak bingung membacanya.

    // 1. Payload Suhu
    const payloadTemp = JSON.stringify({
        temperature: randomTemp,  // <-- UBAH 'value' JADI 'temperature'
        voltage: randomVoltage,
        timestamp: timestamp
    });

    // 2. Payload Tekanan
    const payloadPressure = JSON.stringify({
        pressure: randomPressure, // <-- UBAH 'value' JADI 'pressure'
        voltage: randomVoltage,
        timestamp: timestamp
    });

    // Kirim ke MQTT
    client.publish('plant/data/temperature', payloadTemp);
    client.publish('plant/data/pressure', payloadPressure);

    console.log(`📤 SEND: Temp=${randomTemp}°C | Pressure=${randomPressure} Bar`);
}
