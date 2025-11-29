const WebSocket = require('ws');

const WS_URL = "wss://100.26.106.29/agent?token=CFt5eAKacLytBXIu/wPkC4JdTdyTt7aZa9Q33R9W1NfU=VALUE";

console.log(`Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL, {
    rejectUnauthorized: false
});

ws.on('open', () => {
    console.log('Connected!');
    ws.send(JSON.stringify({ type: 'hello', nodeId: 'test-client' }));
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

ws.on('close', (code, reason) => {
    console.log(`Disconnected. Code: ${code}, Reason: ${reason.toString()}`);
});

ws.on('error', (err) => {
    console.error('Error:', err.message);
});
