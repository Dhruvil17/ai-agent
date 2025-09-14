const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const alawmulaw = require("alawmulaw");
const bodyParser = require("body-parser");
const axios = require("axios");
const qs = require("qs");
const dotenv = require("dotenv");
const morgan = require("morgan");
const { AssemblyAI } = require("assemblyai");
const { sendMessage } = require("./backend_model");
dotenv.config();

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const PORT = process.env.PORT;
const BACKEND_URL = process.env.BACKEND_URL;

// Middleware setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(morgan("dev"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

let callSid = "";
let answer = "";
let isCallActive = false;
let isCurrentlyPlaying = false;

// Function to calculate RMS and check if it crosses the threshold
const isSpeechDetected = (linear16Data) => {
    const floatSamples = new Float32Array(linear16Data.length);
    for (let i = 0; i < linear16Data.length; i++) {
        floatSamples[i] = linear16Data[i] / 32768.0;
    }

    const windowSize = 160;
    const numWindows = Math.floor(floatSamples.length / windowSize);
    let windowRMSValues = [];

    for (let i = 0; i < numWindows; i++) {
        const startIdx = i * windowSize;
        const endIdx = startIdx + windowSize;
        const window = floatSamples.slice(startIdx, endIdx);

        const sumSquares = window.reduce(
            (sum, sample) => sum + sample * sample,
            0
        );
        const windowRMS = Math.sqrt(sumSquares / windowSize);
        windowRMSValues.push(windowRMS);
    }

    const avgRMS =
        windowRMSValues.reduce((sum, rms) => sum + rms, 0) /
        windowRMSValues.length;
    const maxRMS = Math.max(...windowRMSValues);

    const avgDB = 20 * Math.log10(avgRMS);
    const maxDB = 20 * Math.log10(maxRMS);

    const NOISE_FLOOR_DB = -20;
    const SPEECH_THRESHOLD_DB = -20;

    return maxDB > SPEECH_THRESHOLD_DB && avgDB > NOISE_FLOOR_DB;
};

// Handle WebSocket connections
wss.on("connection", async (ws) => {
    console.log("ws: client connected");

    let accumulatedAudio = [];
    const PAUSE_THRESHOLD = 1000; // Reduced for better responsiveness
    const OPTIMAL_MIN_DURATION = 50; // 50ms chunks as recommended
    const OPTIMAL_MAX_DURATION = 200; // Shorter chunks for better latency

    let accumulatedAudioBuffer = Buffer.alloc(0);
    let lastSendTime = Date.now();
    let transcriber = null;
    let isTranscriberReady = false;

    // Initialize AssemblyAI client
    const client = new AssemblyAI({
        apiKey: process.env.ASSEMBLYAI_API_KEY,
    });

    // Function to create and setup transcriber using the NEW Universal Streaming API
    const setupTranscriber = async () => {
        try {
            console.log("Setting up AssemblyAI transcriber...");

            // Use the NEW streaming API
            transcriber = client.streaming.transcriber({
                sampleRate: 8000, // Twilio uses 8kHz
                encoding: "pcm_s16le", // 16-bit PCM
                formatTurns: true, // Enable text formatting
                endOfTurnConfidenceThreshold: 0.4, // Default confidence threshold
                minEndOfTurnSilenceWhenConfident: 400, // 400ms silence when confident
                maxTurnSilence: 1280, // 1.28s max silence before end of turn
            });

            // Setup event listeners for Universal Streaming API
            transcriber.on("open", ({ id }) => {
                console.log(
                    `✅ Connected to Universal Streaming service - Session ID: ${id}`
                );
                isTranscriberReady = true;
            });

            transcriber.on("turn", async (turn) => {
                try {
                    const transcript = turn.transcript;
                    if (!transcript) return;

                    console.log(
                        `Turn (${turn.turn_order}) ->>>>>>>> "${transcript}" ` +
                            `(end_of_turn: ${turn.end_of_turn}, formatted: ${turn.turn_is_formatted}) ` +
                            new Date().toLocaleString()
                    );

                    // Process when we have a complete turn with formatting
                    if (
                        turn.end_of_turn &&
                        turn.turn_is_formatted &&
                        transcript.trim()
                    ) {
                        console.log("Processing complete turn...");
                        answer = await sendMessage(transcript);
                        console.log("AI Response generated:", answer);

                        const maxResponseLength = 2000;
                        if (answer.length > maxResponseLength) {
                            answer = answer.substring(0, maxResponseLength);
                        }

                        if (isCallActive && callSid) {
                            console.log(
                                "Updating Twilio call with response..."
                            );
                            await updateCall();
                            accumulatedAudio = [];
                        } else {
                            console.log(
                                "Call ended while processing, skipping TwiML update"
                            );
                        }
                    }
                } catch (error) {
                    console.error("Error processing turn:", error);
                    // Don't let transcriber errors crash the call
                }
            });

            transcriber.on("error", (error) => {
                console.error("❌ Transcriber error:", error);
                isTranscriberReady = false;
            });

            transcriber.on("close", (code, reason) => {
                console.log(
                    `🔌 Disconnected from Universal Streaming service: ${code} ${reason}`
                );
                isTranscriberReady = false;
            });

            // Connect to AssemblyAI Universal Streaming
            console.log("Connecting to AssemblyAI...");
            await transcriber.connect();
            console.log("✅ Transcriber setup completed");
        } catch (error) {
            console.error("❌ Error setting up transcriber:", error);
            isTranscriberReady = false;
        }
    };

    ws.on("message", async (message) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case "connected":
                isCallActive = true;
                console.log("A new call has connected.");
                break;

            case "start":
                callSid = msg.start.callSid;
                console.log(`Starting Media Stream ${msg.streamSid}`);

                // Initialize transcriber when stream starts
                await setupTranscriber();

                // Send welcome message
                const data = qs.stringify({
                    Twiml: `<Response>
                                <Say language="en-IN">Hello! I'm your AI sales assistant. How can I help you today?</Say>
                                <Redirect method="POST">${BACKEND_URL}/process-user-input</Redirect>
                        </Response>`,
                });

                const config = {
                    method: "post",
                    maxBodyLength: Infinity,
                    url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Authorization:
                            "Basic QUM5MTJiMzFjNDQxYTIzZjQzZDc0NzBkMzAxNDM3ODhjOToxOTJhYjRlOTI1OTMxMzllNWJiNzA4MzNiMmQ4MGJjMQ==",
                    },
                    data: data,
                };

                try {
                    await axios.request(config);
                    console.log("Welcome message played successfully");
                } catch (error) {
                    console.error(
                        "Error playing welcome message:",
                        error.response ? error.response.data : error.message
                    );
                }
                break;

            case "media":
                if (!isCallActive || !isTranscriberReady || !transcriber) {
                    return;
                }

                try {
                    // Convert incoming audio (Twilio sends mulaw encoded audio)
                    const audioBuffer = Buffer.from(
                        msg.media.payload,
                        "base64"
                    );
                    const uint8AudioBuffer = new Uint8Array(audioBuffer);
                    const linear16Buffer =
                        alawmulaw.mulaw.decode(uint8AudioBuffer);
                    const audioBufferToSend = Buffer.from(
                        linear16Buffer.buffer
                    );

                    // Accumulate audio
                    accumulatedAudioBuffer = Buffer.concat([
                        accumulatedAudioBuffer,
                        audioBufferToSend,
                    ]);

                    // Calculate current buffer duration in milliseconds
                    const duration =
                        (accumulatedAudioBuffer.length / 2 / 8000) * 1000;
                    const timeSinceLastSend = Date.now() - lastSendTime;

                    // Check conditions for sending audio (send smaller, more frequent chunks)
                    const shouldSendDueToSize =
                        duration >= OPTIMAL_MIN_DURATION;
                    const shouldSendDueToTime =
                        timeSinceLastSend >= PAUSE_THRESHOLD;

                    if (accumulatedAudioBuffer.length < 400) {
                        return;
                    }
                    // Interrupt detection
                    if (isCurrentlyPlaying) {
                        const speechDetected = isSpeechDetected(linear16Buffer);
                        if (speechDetected) {
                            console.log(
                                "Speech detected, interrupting current TwiML"
                            );
                            isCurrentlyPlaying = false;
                            await stopCurrentTwiML();
                        }
                    }

                    // Send audio when conditions are met
                    if (
                        (shouldSendDueToSize || shouldSendDueToTime) &&
                        accumulatedAudioBuffer.length > 0
                    ) {
                        try {
                            // Send audio using the NEW Universal Streaming API
                            transcriber.send(accumulatedAudioBuffer);

                            // Reset buffer and timing
                            accumulatedAudioBuffer = Buffer.alloc(0);
                            lastSendTime = Date.now();
                        } catch (error) {
                            console.error(
                                "Error sending audio to transcriber:",
                                error
                            );
                            // Reset buffer on error
                            accumulatedAudioBuffer = Buffer.alloc(0);
                            lastSendTime = Date.now();

                            // If socket is closed, try to reconnect
                            if (error.message.includes("Socket is not open")) {
                                console.log(
                                    "Attempting to reconnect transcriber..."
                                );
                                isTranscriberReady = false;
                                setTimeout(async () => {
                                    await setupTranscriber();
                                }, 1000);
                            }
                        }
                    }
                } catch (error) {
                    console.error("Error processing audio:", error);
                    accumulatedAudioBuffer = Buffer.alloc(0);
                    lastSendTime = Date.now();
                }
                break;

            case "stop":
                isCallActive = false;
                isCurrentlyPlaying = false;
                console.log("Call has ended");

                // Send any remaining audio before closing
                if (
                    accumulatedAudioBuffer.length > 0 &&
                    transcriber &&
                    isTranscriberReady
                ) {
                    try {
                        transcriber.send(accumulatedAudioBuffer);
                    } catch (error) {
                        console.error(
                            "Error sending final audio chunk:",
                            error
                        );
                    }
                }
                break;
        }
    });

    ws.on("close", async () => {
        console.log("Twilio media stream WebSocket disconnected");

        // Close transcriber properly
        if (transcriber) {
            try {
                await transcriber.close();
            } catch (error) {
                console.error("Error closing transcriber:", error);
            }
        }
    });
});

// Update Twilio call with the response
const updateCall = async () => {
    try {
        if (!callSid || !isCallActive) {
            console.log(
                "Call is not active or no callSid provided, skipping TwiML update"
            );
            return;
        }

        // Sanitize the answer to prevent TwiML injection
        const sanitizedAnswer = answer.replace(/[<>&"']/g, (match) => {
            const escapeMap = {
                "<": "&lt;",
                ">": "&gt;",
                "&": "&amp;",
                '"': "&quot;",
                "'": "&#39;",
            };
            return escapeMap[match];
        });

        const twimlResponse = `<Response>
                <Say language="en-IN">${sanitizedAnswer}</Say>
                <Pause length="2"/>
                <Gather input="speech" action="${BACKEND_URL}/process-user-input" method="POST" timeout="600"></Gather>
                <Say language="en-IN">We have not received any input from your side. Feel free to reach out to us again. Goodbye!</Say>
            </Response>`;

        let finalTwimlResponse = twimlResponse;
        if (twimlResponse.length > 4000) {
            console.error(
                `TwiML too large: ${twimlResponse.length} chars (max: 4000)`
            );
            const maxAnswerLength = 1500;
            const truncatedAnswer =
                sanitizedAnswer.substring(0, maxAnswerLength) + "...";
            finalTwimlResponse = `<Response>
                <Say language="en-IN">${truncatedAnswer}</Say>
                <Pause length="2"/>
                <Gather input="speech" action="${BACKEND_URL}/process-user-input" method="POST" timeout="600"></Gather>
                <Say language="en-IN">We have not received any input from your side. Feel free to reach out to us again. Goodbye!</Say>
            </Response>`;

            console.log("Using truncated TwiML response");
        }

        console.log("Sending TwiML to Twilio:", finalTwimlResponse);

        const data = qs.stringify({
            Twiml: finalTwimlResponse,
        });

        const config = {
            method: "post",
            maxBodyLength: Infinity,
            url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization:
                    "Basic QUM5MTJiMzFjNDQxYTIzZjQzZDc0NzBkMzAxNDM3ODhjOToxOTJhYjRlOTI1OTMxMzllNWJiNzA4MzNiMmQ4MGJjMQ==",
            },
            data: data,
        };

        try {
            const response = await axios.request(config);
            isCurrentlyPlaying = true;
            console.log("✅ TwiML updated successfully, bot is now speaking");
            console.log("Twilio response status:", response.status);
        } catch (error) {
            if (error.response) {
                console.error("❌ Twilio API Error:", {
                    status: error.response.status,
                    data: error.response.data,
                    callSid: callSid,
                });

                if (error.response.data.code === 21220) {
                    console.log("Call already ended, cannot update TwiML");
                } else if (error.response.data.code === 20003) {
                    console.log(
                        "Authentication error - check Twilio credentials"
                    );
                } else if (error.response.data.code === 20404) {
                    console.log("Call not found - call may have ended");
                }
            } else {
                console.error(
                    "❌ Network error updating TwiML:",
                    error.message
                );
            }
        }
    } catch (err) {
        console.error("Error in updateCall:", err.message);
    }
};

const stopCurrentTwiML = async () => {
    if (!callSid || !isCallActive) {
        console.log(
            "Call is not active or no callSid provided, skipping TwiML stop"
        );
        return;
    }

    const data = qs.stringify({
        Twiml: `
            <Response>
                <Gather input="speech" action="${BACKEND_URL}/process-user-input" method="POST" timeout="600">
                    <Pause length="1"/>
                </Gather>
            </Response>
        `,
    });

    const config = {
        method: "post",
        maxBodyLength: Infinity,
        url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
                "Basic QUM5MTJiMzFjNDQxYTIzZjQzZDc0NzBkMzAxNDM3ODhjOToxOTJhYjRlOTI1OTMxMzllNWJiNzA4MzNiMmQ4MGJjMQ==",
        },
        data: data,
    };

    try {
        await axios.request(config);
        console.log(
            "Successfully interrupted current TwiML, waiting for user input"
        );
    } catch (error) {
        if (error.response && error.response.data.code === 21220) {
            console.log("Call already ended, cannot modify TwiML");
        } else {
            console.error(
                "Error interrupting TwiML:",
                error.response ? error.response.data : error.message
            );
        }
    }
};

app.post("/process-user-input", (req, res) => {
    try {
        console.log("Received webhook from Twilio:", req.body);
        res.type("text/xml");

        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                                <Response>
                                    <Gather input="speech" action="${BACKEND_URL}/process-user-input" method="POST" timeout="600">
                                        <Pause length="1"/>
                                    </Gather>
                                    <Say language="en-IN">We have not received any input from your side. Feel free to reach out to us again. Goodbye!</Say>
                                </Response>`;

        console.log("Sending TwiML response:", twimlResponse);
        res.send(twimlResponse);
    } catch (error) {
        console.error("Error in process-user-input webhook:", error);
        res.type("text/xml");
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
                    <Response>
                        <Say language="en-IN">Sorry, there was an error processing your request. Please try again later.</Say>
                        <Hangup/>
                    </Response>`);
    }
});

// GET route
app.get("/", (req, res) => {
    console.log("GET request received");
    res.status(200).send("Server is running");
});

app.post("/", (req, res) => {
    console.log("Body:", req.body);
    res.status(200).json({ message: "POST request received!", body: req.body });
});

console.log(`🚀 Server starting on port ${PORT}`);
server.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📞 WebSocket server ready for Twilio connections`);
    console.log(`🎤 AssemblyAI integration ready`);
    console.log(`🔗 All webhooks will use: ${BACKEND_URL}`);
});
