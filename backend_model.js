require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Main function to process messages directly with Gemini
exports.sendMessage = async function processMessage(finalTranscript) {
    try {
        console.log("Processing message: " + new Date().toLocaleString());

        // Get the Gemini model
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        // Create the prompt
        const prompt = `You are a helpful and knowledgeable AI assistant. Provide clear, professional, and accurate responses. Be conversational and helpful in your interactions.
        User's question: ${finalTranscript}
        Please provide a helpful and accurate response to the user's question.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const answer = response.text().trim();

        console.log("Message processed: " + new Date().toLocaleString());
        console.log("Answer:", answer);

        return answer;
    } catch (error) {
        console.error("Error processing message:", error);
        return "I'm sorry, I encountered an error processing your request.";
    }
};
