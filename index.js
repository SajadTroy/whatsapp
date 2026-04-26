require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const { default: PQueue } = require('p-queue');

// Configuration
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook-test/whatsapp';
const QUEUE_DELAY_MS = parseInt(process.env.QUEUE_DELAY_MS || '2000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

// Initialize Queue (concurrency 1 ensures sequential processing)
const messageQueue = new PQueue({ concurrency: 1 });

// Initialize WhatsApp Client with LocalAuth for session persistence
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    console.log('QR RECEIVED. Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', async (msg) => {
    // Ignore status broadcasts and group messages
    if (msg.isStatus || msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter')) return;

    const incomingText = msg.body;
    const userNumber = msg.from; // e.g. 1234567890@c.us

    console.log(`[INCOMING] Received message from ${userNumber}: ${incomingText}`);

    let attempt = 1;
    let webhookSuccess = false;

    while (attempt <= MAX_RETRIES && !webhookSuccess) {
        try {
            // Send to n8n webhook
            console.log(`[WEBHOOK] Sending POST request to n8n for user ${userNumber} (Attempt ${attempt}/${MAX_RETRIES})...`);
            const response = await axios.post(N8N_WEBHOOK_URL, {
                message: incomingText,
                user: userNumber
            });

            // n8n should respond with { reply: "..." }
            if (response.data && response.data.reply) {
                const replyMessage = response.data.reply;
                console.log(`[WEBHOOK] Received reply for user ${userNumber}. Adding to queue...`);
                
                // Queue the response
                addMessageToQueue(userNumber, replyMessage);
                webhookSuccess = true;
            } else {
                console.log(`[WEBHOOK] No 'reply' field found in n8n response for user ${userNumber}.`);
                attempt++;
                if (attempt <= MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY_MS));
                }
            }

        } catch (error) {
            console.error(`[ERROR] Webhook call failed for user ${userNumber} on attempt ${attempt}:`, error.message);
            if (error.response) {
                 console.error('[ERROR] Webhook Response Data:', error.response.data);
            }
            attempt++;
            if (attempt <= MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY_MS));
            }
        }
    }

    if (!webhookSuccess) {
        console.error(`[ERROR] Max retries reached. Failed to get a valid reply from webhook for user ${userNumber}.`);
    }
});

// Function to handle the queued jobs
function addMessageToQueue(userNumber, replyMessage) {
    messageQueue.add(async () => {
        let attempt = 1;
        let success = false;

        while (attempt <= MAX_RETRIES && !success) {
            try {
                 console.log(`[QUEUE] Processing message for ${userNumber} (Attempt ${attempt}/${MAX_RETRIES})...`);
                 
                 // Send via WhatsApp
                 await client.sendMessage(userNumber, replyMessage);
                 
                 console.log(`[QUEUE] Successfully sent message to ${userNumber}.`);
                 success = true;

            } catch (error) {
                 console.error(`[ERROR] Failed to send message to ${userNumber} on attempt ${attempt}:`, error.message);
                 attempt++;
                 if (attempt <= MAX_RETRIES) {
                     // Adding a small delay before retry (e.g. half the normal delay)
                     await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY_MS / 2));
                 }
            }
        }

        if (!success) {
             console.error(`[ERROR] Max retries reached. Failed to send message to ${userNumber} after ${MAX_RETRIES} attempts.`);
        }

        // Artificial delay *after* the job completes (or fails all retries) to respect rate limits before the next job starts.
        console.log(`[QUEUE] Waiting ${QUEUE_DELAY_MS}ms before next possible job...`);
        await new Promise(resolve => setTimeout(resolve, QUEUE_DELAY_MS));
    });
}

client.initialize();
