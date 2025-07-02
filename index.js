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

        console.log(`Making ${method} request to: ${config.url}`);
        if (data) {
            console.log('Request data:', JSON.stringify(data, null, 2));
        }

        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error('Jira API Error Details:');
        console.error('Status:', error.response?.status);
        console.error('Status Text:', error.response?.statusText);
        console.error('Response Data:', JSON.stringify(error.response?.data, null, 2));
        console.error('Request URL:', error.config?.url);
        console.error('Request Method:', error.config?.method);
        if (error.config?.data) {
            console.error('Request Data:', error.config.data);
        }
        
        // Return more detailed error message
        const errorMsg = error.response?.data?.errorMessages?.[0] || 
                        error.response?.data?.errors || 
                        error.response?.statusText || 
                        error.message;
        
        throw new Error(`Jira API Error (${error.response?.status}): ${JSON.stringify(errorMsg)}`);
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
        console.log('Searching with JQL:', jql);
        const searchEndpoint = `search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,priority,issuetype,created,updated,description&maxResults=20`;
        const result = await makeJiraRequest(searchEndpoint);
        console.log(`Search returned ${result.issues?.length || 0} issues`);
        return result;
    } catch (error) {
        console.error('Error searching Jira issues:', error);
        throw error;
    }
}

// Debug function to test Jira connection
async function testJiraConnection() {
    try {
        console.log('Testing Jira connection...');
        
        // Test basic auth
        const myself = await makeJiraRequest('myself');
        console.log('Authenticated as:', myself.displayName, myself.emailAddress);
        
        // Test project access
        const project = await makeJiraRequest(`project/${jiraConfig.projectKey}`);
        console.log('Project access OK:', project.name);
        
        // Test simple search
        const searchResult = await makeJiraRequest(`search?jql=project="${jiraConfig.projectKey}"&maxResults=1`);
        console.log('Search access OK, total issues:', searchResult.total);
        
        return {
            success: true,
            user: myself.displayName,
            project: project.name,
            totalIssues: searchResult.total
        };
    } catch (error) {
        console.error('Jira connection test failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}
async function getProjectUsers() {
    try {
        const response = await makeJiraRequest(`user/assignable/search?project=${jiraConfig.projectKey}&maxResults=50`);
        return response;
    } catch (error) {
        console.error('Error getting project users:', error);
        return [];
    }
}

// Function to get issue types for the project
async function getIssueTypes() {
    try {
        const response = await makeJiraRequest('issuetype');
        return response;
    } catch (error) {
        console.error('Error getting issue types:', error);
        return [];
    }
}

// Function to fuzzy match user names
function findBestUserMatch(query, users) {
    if (!query || !users.length) return null;
    
    const lowerQuery = query.toLowerCase();
    
    // Exact matches first
    let match = users.find(user => 
        user.displayName.toLowerCase() === lowerQuery ||
        user.emailAddress.toLowerCase() === lowerQuery ||
        user.accountId.toLowerCase() === lowerQuery
    );
    
    if (match) return match;
    
    // Partial matches
    match = users.find(user =>
        user.displayName.toLowerCase().includes(lowerQuery) ||
        user.emailAddress.toLowerCase().includes(lowerQuery)
    );
    
    return match;
}

// Function to analyze user intent (read vs write operation)
async function analyzeUserIntent(userQuery) {
    const prompt = `Analyze this user query and determine if it's a READ operation (searching/viewing) or WRITE operation (creating/updating/deleting).

User Query: "${userQuery}"

WRITE operations keywords: create, add, make, new, update, edit, modify, change, delete, remove, close, resolve, assign, move, set status, mark as
READ operations keywords: show, find, search, list, what, get, see, display, tell me

Also extract key information if it's a WRITE operation:
- Operation type: CREATE, UPDATE, or DELETE
- Issue details: type, summary, description, assignee, priority, status
- Target issue: if updating/deleting specific issue

Respond in this JSON format:
{
  "intent": "READ" or "WRITE",
  "operation": "CREATE|UPDATE|DELETE" (only for WRITE),
  "details": {
    "type": "Bug|Task|Story|Epic",
    "summary": "extracted summary",
    "description": "extracted description", 
    "assignee": "extracted assignee name",
    "priority": "High|Medium|Low",
    "status": "To Do|In Progress|Done",
    "target": "issue key or description for updates/deletes"
  }
}`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 300,
            temperature: 0.1
        });

        return JSON.parse(response.choices[0].message.content.trim());
    } catch (error) {
        console.error('Error analyzing intent:', error);
        return { intent: "READ" }; // Default to read if analysis fails
    }
}

// Function to create a new Jira issue
async function createJiraIssue(issueDetails, users, issueTypes) {
    try {
        console.log('Creating issue with details:', issueDetails);
        
        // Find assignee if specified
        let assigneeId = null;
        if (issueDetails.assignee) {
            const assignee = findBestUserMatch(issueDetails.assignee, users);
            console.log('Found assignee match:', assignee);
            if (assignee) {
                assigneeId = assignee.accountId;
            }
        }

        // Find issue type ID - let's get project-specific issue types
        const projectMeta = await makeJiraRequest(`issue/createmeta?projectKeys=${jiraConfig.projectKey}&expand=projects.issuetypes.fields`);
        console.log('Project metadata:', JSON.stringify(projectMeta, null, 2));
        
        const project = projectMeta.projects[0];
        if (!project) {
            throw new Error('Project not found or no permission to create issues');
        }

        // Default to first available issue type if not specified or not found
        let issueType = project.issuetypes[0]; // Default to first available
        
        if (issueDetails.type) {
            const typeMatch = project.issuetypes.find(type => 
                type.name.toLowerCase() === issueDetails.type.toLowerCase()
            );
            if (typeMatch) {
                issueType = typeMatch;
            }
        }

        console.log('Using issue type:', issueType);

        const issueData = {
            fields: {
                project: {
                    key: jiraConfig.projectKey
                },
                summary: issueDetails.summary || 'New Issue',
                issuetype: {
                    id: issueType.id
                }
            }
        };

        // Add description if the field is available
        if (issueType.fields && issueType.fields.description) {
            issueData.fields.description = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                type: "text",
                                text: issueDetails.description || 'No description provided'
                            }
                        ]
                    }
                ]
            };
        }

        // Add assignee if found and field is available
        if (assigneeId && issueType.fields && issueType.fields.assignee) {
            issueData.fields.assignee = { accountId: assigneeId };
        }

        // Add priority if specified and field is available
        if (issueDetails.priority && issueType.fields && issueType.fields.priority) {
            const priorityMap = {
                'highest': '1',
                'high': '2', 
                'medium': '3',
                'low': '4',
                'lowest': '5'
            };
            const priorityId = priorityMap[issueDetails.priority.toLowerCase()];
            if (priorityId) {
                issueData.fields.priority = { id: priorityId };
            }
        }

        console.log('Final issue data:', JSON.stringify(issueData, null, 2));
        const result = await makeJiraRequest('issue', 'POST', issueData);
        return result;
    } catch (error) {
        console.error('Error creating issue:', error);
        throw error;
    }
}

// Function to update a Jira issue
async function updateJiraIssue(issueKey, updateDetails, users) {
    try {
        const updateData = { fields: {} };

        // Update summary
        if (updateDetails.summary) {
            updateData.fields.summary = updateDetails.summary;
        }

        // Update description
        if (updateDetails.description) {
            updateData.fields.description = {
                type: "doc",
                version: 1,
                content: [
                    {
                        type: "paragraph",
                        content: [
                            {
                                type: "text",
                                text: updateDetails.description
                            }
                        ]
                    }
                ]
            };
        }

        // Update assignee
        if (updateDetails.assignee) {
            const assignee = findBestUserMatch(updateDetails.assignee, users);
            if (assignee) {
                updateData.fields.assignee = { accountId: assignee.accountId };
            }
        }

        // Update priority
        if (updateDetails.priority) {
            const priorityMap = {
                'highest': '1',
                'high': '2',
                'medium': '3', 
                'low': '4',
                'lowest': '5'
            };
            const priorityId = priorityMap[updateDetails.priority.toLowerCase()];
            if (priorityId) {
                updateData.fields.priority = { id: priorityId };
            }
        }

        const result = await makeJiraRequest(`issue/${issueKey}`, 'PUT', updateData);
        
        // Handle status transitions separately if needed
        if (updateDetails.status) {
            await transitionIssue(issueKey, updateDetails.status);
        }

        return result;
    } catch (error) {
        console.error('Error updating issue:', error);
        throw error;
    }
}

// Function to transition issue status
async function transitionIssue(issueKey, targetStatus) {
    try {
        // Get available transitions
        const transitions = await makeJiraRequest(`issue/${issueKey}/transitions`);
        
        // Find matching transition
        const transition = transitions.transitions.find(t => 
            t.name.toLowerCase().includes(targetStatus.toLowerCase()) ||
            t.to.name.toLowerCase() === targetStatus.toLowerCase()
        );

        if (transition) {
            await makeJiraRequest(`issue/${issueKey}/transitions`, 'POST', {
                transition: { id: transition.id }
            });
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error transitioning issue:', error);
        return false;
    }
}

// Function to delete a Jira issue
async function deleteJiraIssue(issueKey) {
    try {
        await makeJiraRequest(`issue/${issueKey}`, 'DELETE');
        return true;
    } catch (error) {
        console.error('Error deleting issue:', error);
        throw error;
    }
}

// Function to find issues for update/delete operations
async function findIssueForOperation(target) {
    try {
        // If it looks like an issue key, use it directly
        if (/^[A-Z]+-\d+$/.test(target)) {
            return target;
        }

        // Otherwise, search by summary
        const jql = `project = "${jiraConfig.projectKey}" AND summary ~ "${target}"`;
        const results = await searchJiraIssues(jql);
        
        if (results.issues && results.issues.length > 0) {
            return results.issues[0].key; // Return first match
        }
        
        return null;
    } catch (error) {
        console.error('Error finding issue:', error);
        return null;
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

// Main function to handle write operations
async function handleWriteOperation(userQuery, operation, details) {
    try {
        console.log(`Processing ${operation} operation:`, details);
        
        // Get necessary data
        const [users, issueTypes] = await Promise.all([
            getProjectUsers(),
            getIssueTypes()
        ]);

        let result;
        let responseMessage;

        switch (operation) {
            case 'CREATE':
                result = await createJiraIssue(details, users, issueTypes);
                responseMessage = `✅ Created new issue: **${result.key}**\n📝 Summary: ${details.summary || 'New Issue'}\n🔗 Link: ${jiraConfig.domain}/browse/${result.key}`;
                break;

            case 'UPDATE':
                const updateIssueKey = await findIssueForOperation(details.target);
                if (!updateIssueKey) {
                    return `❌ I couldn't find an issue matching "${details.target}". Please be more specific or provide the issue key.`;
                }
                
                await updateJiraIssue(updateIssueKey, details, users);
                responseMessage = `✅ Updated issue: **${updateIssueKey}**\n🔗 Link: ${jiraConfig.domain}/browse/${updateIssueKey}`;
                break;

            case 'DELETE':
                const deleteIssueKey = await findIssueForOperation(details.target);
                if (!deleteIssueKey) {
                    return `❌ I couldn't find an issue matching "${details.target}". Please be more specific or provide the issue key.`;
                }
                
                await deleteJiraIssue(deleteIssueKey);
                responseMessage = `✅ Deleted issue: **${deleteIssueKey}**`;
                break;

            default:
                return `❌ Unknown operation: ${operation}`;
        }

        return responseMessage;
    } catch (error) {
        console.error(`Error handling ${operation} operation:`, error);
        return `❌ Sorry, I encountered an error while ${operation.toLowerCase()}ing the issue: ${error.message}`;
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

// Main query handler that routes to read or write operations
async function handleQuery(userQuery) {
    try {
        // Analyze user intent
        const analysis = await analyzeUserIntent(userQuery);
        console.log('Intent analysis:', analysis);

        if (analysis.intent === 'WRITE') {
            return await handleWriteOperation(userQuery, analysis.operation, analysis.details);
        } else {
            return await handleReadQuery(userQuery);
        }
    } catch (error) {
        console.error('Error handling query:', error);
        return `Sorry, I encountered an error while processing your request: ${error.message}`;
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
        message.reply(`Hi! I can help you with Jira tickets. Here's what I can do:

**📖 Read Operations:**
• "show me bugs assigned to john"
• "what tasks are in progress?"
• "high priority issues"
• "find issues about login problems"

**✏️ Write Operations:**
• "create a bug for login issue assigned to sarah"
• "update AAD-123 priority to high"
• "mark AAD-456 as done"
• "delete the test issue"
• "assign the shopping cart bug to mike"

**🔧 Debug Commands:**
• "test connection" - Check if Jira connection is working

Ask me anything!`);
        return;
    }
    
    // Handle debug commands
    if (query.toLowerCase().includes('test connection') || query.toLowerCase().includes('debug')) {
        const testResult = await testJiraConnection();
        if (testResult.success) {
            message.reply(`✅ **Jira Connection Test Passed!**
👤 Authenticated as: ${testResult.user}
📁 Project: ${testResult.project}
📊 Total issues in project: ${testResult.totalIssues}`);
        } else {
            message.reply(`❌ **Jira Connection Test Failed!**
Error: ${testResult.error}
            
Please check:
- JIRA_TOKEN is valid and not expired
- JIRA_EMAIL is correct
- JIRA_DOMAIN is accessible
- User has permission to access project ${jiraConfig.projectKey}`);
        }
        return;
    }
    
    // Show typing indicator
    message.channel.sendTyping();
    
    try {
        const response = await handleQuery(query);
        
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
    handleQuery,
    handleReadQuery,
    handleWriteOperation,
    naturalLanguageToJQL,
    searchJiraIssues,
    formatJiraResults,
    analyzeUserIntent,
    createJiraIssue,
    updateJiraIssue,
    deleteJiraIssue
};
