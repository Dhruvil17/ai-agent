const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const alawmulaw = require("alawmulaw");
const bodyParser = require("body-parser");
const axios = require("axios");
const qs = require("qs");
const dotenv = require("dotenv");
const { AssemblyAI } = require("assemblyai");
const { sendMessage } = require("./backend_model");
dotenv.config();

// Twilio configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const PORT = process.env.PORT;

// Middleware setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

let callSid = "";
let answer = "";
let isCallActive = false;
let isCurrentlyPlaying = false;

// Function to calculate RMS and check if it crosses the threshold
const isSpeechDetected = (linear16Data) => {
    // Convert Int16Array to normalized float values
    const floatSamples = new Float32Array(linear16Data.length);
    for (let i = 0; i < linear16Data.length; i++) {
        floatSamples[i] = linear16Data[i] / 32768.0; // Normalize to [-1, 1]
    }

    // Use a sliding window for more accurate RMS calculation
    const windowSize = 160; // 20ms at 8kHz sample rate
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

    // Calculate statistics
    const avgRMS =
        windowRMSValues.reduce((sum, rms) => sum + rms, 0) /
        windowRMSValues.length;
    const maxRMS = Math.max(...windowRMSValues);

    // Convert to dB
    const avgDB = 20 * Math.log10(avgRMS);
    const maxDB = 20 * Math.log10(maxRMS);

    // Thresholds
    const NOISE_FLOOR_DB = -20; // Typical noise floor
    const SPEECH_THRESHOLD_DB = -20; // Typical speech threshold

    // Decision making
    return maxDB > SPEECH_THRESHOLD_DB && avgDB > NOISE_FLOOR_DB;
};

// Handle WebSocket connections
wss.on("connection", async (ws) => {
    console.log("ws: client connected");

    let pauseTimer = null;
    let accumulatedAudio = [];
    const PAUSE_THRESHOLD = 2000;

    // Define optimal duration in milliseconds
    const OPTIMAL_MIN_DURATION = 100; // Minimum duration in milliseconds
    const OPTIMAL_MAX_DURATION = 450; // Maximum duration in milliseconds

    let accumulatedAudioBuffer = Buffer.alloc(0);
    let lastSendTime = Date.now(); // Track the last time audio was sent to the API

    const client = new AssemblyAI({
        apiKey: process.env.ASSEMBLYAI_API_KEY,
    });

    const transcriber = client.realtime.transcriber({
        encoding: "pcm_s16le",
        sampleRate: 8000,
        speech_model: "best",
        endUtteranceSilenceThreshold: 1000, // Default is 700ms, we can keep it default or change it as well
    });

    const transcriberConnectionPromise = transcriber.connect();

    transcriber.on("transcript.partial", (partialTranscript) => {
        const transcript = partialTranscript.text;

        if (!transcript) return;

        console.log(
            "Partial ->>>>>>>> " +
                transcript +
                " " +
                new Date().toLocaleString()
        );
    });

    transcriber.on("transcript.final", async (finalTranscript) => {
        console.log(
            "Final ->>>>>>>> " +
                finalTranscript.text +
                " " +
                new Date().toLocaleString()
        );

        answer = await sendMessage(finalTranscript.text);

        if (isCallActive) {
            await updateCall();
            accumulatedAudio = [];
        } else {
            console.log("Call ended while processing, skipping TwiML update");
        }
    });

    transcriber.on("open", () => console.log("Connected to real-time service"));

    transcriber.on("error", console.error);

    transcriber.on("close", () =>
        console.log("Disconnected from real-time service")
    );

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

                const data = qs.stringify({
                    Twiml: `<Response>
                                <Say language="en-IN">Hello! Welcome to Hyundai Motors! How may I assist you today?</Say>
                                <Redirect method="POST">https://salesagent.callhippo.com/process-user-input</Redirect>
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

                axios
                    .request(config)
                    .then(() =>
                        console.log("Welcome message played successfully")
                    )
                    .catch((error) =>
                        console.error(
                            "Error playing welcome message:",
                            error.response ? error.response.data : error.message
                        )
                    );
                break;

            case "media":
                if (!isCallActive) return;

                try {
                    // Convert incoming audio
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

                    // Calculate current buffer duration
                    const duration =
                        (accumulatedAudioBuffer.length / 2 / 8000) * 1000;
                    const timeSinceLastSend = Date.now() - lastSendTime;

                    // Check conditions for sending audio
                    const shouldSendDueToSize =
                        duration >= OPTIMAL_MIN_DURATION &&
                        duration <= OPTIMAL_MAX_DURATION;
                    const shouldSendDueToTime =
                        timeSinceLastSend >= PAUSE_THRESHOLD;

                    if (isCurrentlyPlaying) {
                        const speechDetected = isSpeechDetected(linear16Buffer);

                        if (speechDetected) {
                            // console.log("I am called and the twiml is paused");
                            isCurrentlyPlaying = false;
                            await stopCurrentTwiML();
                        }
                    }

                    if (shouldSendDueToSize || shouldSendDueToTime) {
                        if (accumulatedAudioBuffer.length > 0) {
                            await transcriberConnectionPromise;
                            await transcriber.sendAudio(accumulatedAudioBuffer);

                            // Reset buffer and timing
                            accumulatedAudioBuffer = Buffer.alloc(0);
                            lastSendTime = Date.now();
                        }
                    }
                } catch (error) {
                    console.error("Error processing audio:", error);
                    // Optionally reset buffers on error
                    accumulatedAudioBuffer = Buffer.alloc(0);
                    lastSendTime = Date.now();
                }
                break;

            case "stop":
                isCallActive = false;
                isCurrentlyPlaying = false;
                console.log("Call has ended");
                break;
        }
    });

    ws.on("close", async () => {
        console.log("Twilio media stream WebSocket disconnected");
        await transcriber.close();
    });
    await transcriberConnectionPromise;
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

        const data = qs.stringify({
            Twiml: `<Response>
                    <Say language="en-IN">${answer}</Say>
                        <Pause length="2"/>
                    <Gather input="speech" action="https://salesagent.callhippo.com/process-user-input" method="POST" timeout="600"></Gather>
                    <Say language="en-IN">We have not received any input from yourside. Feel free to reach out to us again. Goodbye!</Say>
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
            isCurrentlyPlaying = true;
        } catch (error) {
            if (error.response && error.response.data.code === 21220) {
                console.log("Call already ended, cannot update TwiML");
            } else {
                console.error(
                    "Error updating TwiML:",
                    error.response ? error.response.data : error.message
                );
            }
        }
    } catch (err) {
        console.info("In error of Update Call" + JSON.stringify(err));
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
                <Gather input="speech" action="https://salesagent.callhippo.com/process-user-input" method="POST" timeout="600">
                    <Pause length="2"/>
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
        const response = await axios.request(config);
        console.log("Successfully interrupted current TwiML, call continues");
        return response;
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
    res.type("text/xml");

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Gather finishOnKey="#" action="/process-user-input">
                                </Gather>
                                <Redirect method="POST">/process-user-input</Redirect>
                        </Response>`;

    res.send(twimlResponse);
});

app.post("/", (req, res) => {
    console.log(`Server is running on PORT ${PORT}`);
    res.status(200);
});

console.log(`Listening on port ${PORT}`);
server.listen(PORT);
