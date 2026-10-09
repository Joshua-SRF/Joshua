// ==========================================
// 🔑 CONFIGURATION PANE & WHITELIST GUARD
// ==========================================
const SYSTEM_WHITELIST = ["joshfz"];
// ==========================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { IgApiClient } = require('instagram-private-api');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase & Port Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON || 'PASTE_KEY_HERE';
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Healthcheck endpoint returning {"ok":true}
app.get('/', (req, res) => {
    res.json({ ok: true });
});

// Helper for strict whitelist exclusion guard
function filterWhitelist(list, targetUsername) {
    if (!Array.isArray(list)) return [];
    const targetLower = (targetUsername || '').toLowerCase();
    const whitelistLower = SYSTEM_WHITELIST.map(w => (w || '').toLowerCase());

    return list.filter(item => {
        const handle = typeof item === 'string' ? item : (item.username || item.handle || '');
        const handleLower = handle.toLowerCase();

        if (whitelistLower.includes(handleLower)) {
            return handleLower === targetLower;
        }
        return true;
    });
}

// Instagram Data Fetcher
async function processInstagramJob(targetUsername) {
    const ig = new IgApiClient();

    // Use sessionid pass token saved in environment variables
    const sessionId = process.env.IG_SESSION_ID;
    if (sessionId) {
        ig.state.generateDevice(targetUsername);
        await ig.state.deserializeCookieJar(JSON.stringify({
            version: 'ig-cookie-jar',
            cookies: [{
                key: 'sessionid',
                value: sessionId,
                domain: 'instagram.com',
                path: '/'
            }]
        }));
    }

    // Handshake / target user lookup
    const targetUser = await ig.user.searchExact(targetUsername);
    const targetId = targetUser.pk;

    // Optional follow/follow-back handshake request to ensure connection validation
    try {
        await ig.friendship.create(targetId);
    } catch (e) {
        console.log('Handshake follow attempt completed/ignored:', e.message);
    }

    // Fetch Followers feed
    const followersFeed = ig.feed.accountFollowers(targetId);
    const followersItems = await followersFeed.items();
    const followersList = followersItems.map(u => u.username);

    // Fetch Following feed
    const followingFeed = ig.feed.accountFollowing(targetId);
    const followingItems = await followingFeed.items();
    const followingList = followingItems.map(u => u.username);

    // Calculate delta relationship summaries
    const followersSet = new Set(followersList.map(u => u.toLowerCase()));
    const followingSet = new Set(followingList.map(u => u.toLowerCase()));

    const nonFollowers = followingList.filter(u => !followersSet.has(u.toLowerCase()));
    const fans = followersList.filter(u => !followingSet.has(u.toLowerCase()));
    const mutuals = followersList.filter(u => followingSet.has(u.toLowerCase()));

    // Apply strict global exclusion guard
    return {
        followers: filterWhitelist(followersList, targetUsername),
        following: filterWhitelist(followingList, targetUsername),
        non_followers: filterWhitelist(nonFollowers, targetUsername),
        fans: filterWhitelist(fans, targetUsername),
        mutuals: filterWhitelist(mutuals, targetUsername)
    };
}

// Continuous Daemon Loop to poll Supabase jobs table
async function pollJobsDaemon() {
    try {
        // Look for next pending job
        const { data: jobs, error } = await supabase
            .from('jobs')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1);

        if (error) {
            console.error('Supabase fetch error:', error.message);
            return;
        }

        if (jobs && jobs.length > 0) {
            const job = jobs[0];
            console.log(`Processing job ${job.id} for target user @${job.target_username}`);

            // Update status to processing
            await supabase
                .from('jobs')
                .update({ status: 'processing', updated_at: new Date().toISOString() })
                .eq('id', job.id);

            try {
                const payload = await processInstagramJob(job.target_username);

                // Update row with results and status done
                await supabase
                    .from('jobs')
                    .update({
                        status: 'done',
                        result: payload,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', job.id);

                console.log(`Job ${job.id} completed successfully.`);
            } catch (jobErr) {
                console.error(`Error executing job ${job.id}:`, jobErr.message);
                await supabase
                    .from('jobs')
                    .update({
                        status: 'error',
                        error: jobErr.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', job.id);
            }
        }
    } catch (daemonErr) {
        console.error('Daemon loop error:', daemonErr.message);
    }
}

// Run daemon loop every 3 seconds
setInterval(pollJobsDaemon, 3000);

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Background daemon worker initialized and polling Supabase jobs table...`);
});
