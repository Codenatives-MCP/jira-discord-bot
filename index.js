const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const OpenAI = require('openai');
require('dotenv').config();

// Initialize clients
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Jira API configuration
const jiraConfig = {
    domain: process.env.JIRA_DOMAIN,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN,
    projectKey: process.env.JIRA_PROJECT_KEY
};

// Create Jira auth header
const jiraAuth = Buffer.from(`${jiraConfig.email}:${jiraConfig.token}`).toString('base64');

// Jira API helper function
async function makeJiraRequest(endpoint, method = 'GET', data = null) {
    try {
        const config = {
            method,
            url: `${jiraConfig.domain}/rest/api/3/${endpoint}`,
            headers: {
                'Authorization': `Basic ${jiraAuth}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        if (data) {
            config.data = data;
        }

        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error('Jira API Error:', error.response?.data || error.message);
        throw error;
    }
}

// Function to convert natural language to JQL using OpenAI
async function naturalLanguageToJQL(userQuery) {
    const prompt = `You are a Jira Query Language (JQL) expert. Convert the following natural language query into a proper JQL query for project "${jiraConfig.projectKey}".

User Query: "${userQuery}"

Guidelines:
- Use project = "${jiraConfig.projectKey}" in all queries
- Common fields: assignee, reporter, status, priority, type, summary, description, created, updated
- Status values: "To Do", "In Progress", "Done", "Backlog"
- Priority values: "Highest", "High", "Medium", "Low", "Lowest"
- Issue types: Story, Task, Bug, Epic
- For fuzzy matching on names/summaries, use ~ operator or contains
- Keep queries focused and relevant
- If asking about specific people, use assignee or reporter fields
- For date ranges, use created >= "YYYY-MM-DD" format

Examples:
- "bugs assigned to john" → project = "${jiraConfig.projectKey}" AND assignee ~ "john" AND type = Bug
- "high priority tasks" → project = "${jiraConfig.projectKey}" AND priority = High AND type in (Task, Story)
- "what's in progress" → project = "${jiraConfig.projectKey}" AND status = "In Progress"

Return ONLY the JQL query, no explanations:`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 150,
            temperature: 0.1
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('OpenAI Error:', error);
        throw error;
    }
}

// Function to search Jira issues
async function searchJiraIssues(jql) {
    try {
        const searchEndpoint = `search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,priority,issuetype,created,updated,description&maxResults=20`;
        const result = await makeJiraRequest(searchEndpoint);
        return result;
    } catch (error) {
        console.error('Error searching Jira issues:', error);
        throw error;
    }
}

// Function to format Jira results using OpenAI
async function formatJiraResults(userQuery, jiraResults) {
    if (!jiraResults.issues || jiraResults.issues.length === 0) {
        return `I couldn't find any issues matching "${userQuery}" in the ${jiraConfig.projectKey} project.`;
    }

    const issuesText = jiraResults.issues.map(issue => {
        const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
        const status = issue.fields.status.name;
        const priority = issue.fields.priority ? issue.fields.priority.name : 'No Priority';
        const type = issue.fields.issuetype.name;
        
        return `${issue.key}: ${issue.fields.summary}
   Type: ${type} | Status: ${status} | Priority: ${priority} | Assignee: ${assignee}`;
    }).join('\n\n');

    const prompt = `You are a helpful Jira assistant. The user asked: "${userQuery}"

Here are the Jira results:
${issuesText}

Please provide a natural, conversational summary of these results. Be concise but informative. Group similar items if relevant, highlight important information, and make it easy to read. If there are many results, summarize the key patterns.

Format your response in a friendly, professional tone as if you're a team member helping out.`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500,
            temperature: 0.3
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error formatting results:', error);
        return `Found ${jiraResults.issues.length} issues:\n\n${issuesText}`;
    }
}

// Main function to handle read queries
async function handleReadQuery(userQuery) {
    try {
        console.log(`Processing query: "${userQuery}"`);
        
        // Step 1: Convert natural language to JQL
        const jql = await naturalLanguageToJQL(userQuery);
        console.log(`Generated JQL: ${jql}`);
        
        // Step 2: Search Jira
        const jiraResults = await searchJiraIssues(jql);
        console.log(`Found ${jiraResults.issues?.length || 0} issues`);
        
        // Step 3: Format results naturally
        const formattedResponse = await formatJiraResults(userQuery, jiraResults);
        
        return formattedResponse;
    } catch (error) {
        console.error('Error handling read query:', error);
        return `Sorry, I encountered an error while searching Jira: ${error.message}`;
    }
}

// Discord bot event handlers
discord.on('ready', () => {
    console.log(`🤖 Bot logged in as ${discord.user.tag}!`);
    console.log(`📋 Connected to Jira: ${jiraConfig.domain}`);
    console.log(`🎯 Project: ${jiraConfig.projectKey}`);
});

discord.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Check if bot is mentioned
    if (!message.mentions.has(discord.user)) return;
    
    // Extract the query (remove the mention)
    const query = message.content.replace(/<@!?\d+>/g, '').trim();
    
    if (!query) {
        message.reply('Hi! Ask me anything about Jira tickets. For example:\n• "show me bugs assigned to john"\n• "what tasks are in progress?"\n• "high priority issues"');
        return;
    }
    
    // Show typing indicator
    message.channel.sendTyping();
    
    try {
        const response = await handleReadQuery(query);
        
        // Split long messages if needed (Discord has 2000 character limit)
        if (response.length > 2000) {
            const chunks = response.match(/.{1,1900}/g);
            for (const chunk of chunks) {
                await message.reply(chunk);
            }
        } else {
            await message.reply(response);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        message.reply('Sorry, something went wrong while processing your request. Please try again.');
    }
});

// Error handling
discord.on('error', console.error);

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
discord.login(process.env.DISCORD_TOKEN);

// Export functions for testing
module.exports = {
    handleReadQuery,
    naturalLanguageToJQL,
    searchJiraIssues,
    formatJiraResults
};
