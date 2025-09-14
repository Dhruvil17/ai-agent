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
        const prompt = `You are a helpful AI sales assistant. Provide clear, professional, and helpful responses. Keep your answers brief and concise and informative. Focus on the most important information only.

        User's question: ${finalTranscript}
        
        Give a short, helpful answer that directly addresses their question.`;

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
