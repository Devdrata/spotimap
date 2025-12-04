// api/api.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const ngeohash = require('ngeohash');
const cookieParser = require('cookie-parser');

// --- 1. DYNAMIC CONFIGURATION & SECRETS ---

// Vercel ENV VARS (Read from dashboard config)
const {
    FRONTEND_URL,
    SPOTIPY_CLIENT_ID,
    SPOTIPY_CLIENT_SECRET,
    SPOTIPY_REDIRECT_URI,
    FLASK_SECRET_KEY, // Used as a simple secret key for cookie signing
    FIREBASE_CREDENTIALS,
} = process.env;

// Set FRONTEND_URL fallback for local testing
const PROD_FRONTEND_URL = FRONTEND_URL || 'http://127.0.0.1:5173';
const FIREBASE_JSON = FIREBASE_CREDENTIALS ? JSON.parse(FIREBASE_CREDENTIALS) : null;

// Constants (Matching Python)
const SCOPE = "user-read-currently-playing user-read-private";
const EARTH_RADIUS_KM = 6371;

// --- 2. FIREBASE INITIALIZATION ---

try {
    // Only initialize if we have credentials (Prod or Local File fallback)
    if (FIREBASE_JSON || require('fs').existsSync('../firebase-key.json')) {
        const credentials = FIREBASE_JSON ? cert(FIREBASE_JSON) : cert(require('../firebase-key.json'));
        
        // Prevents reinitialization in Vercel hot-reloads
        if (!firebase_admin.apps || firebase_admin.apps.length === 0) {
             initializeApp({ credential: credentials });
        }
    }
} catch (error) {
    console.error("FIREBASE INITIALIZATION FAILED:", error.message);
}

const db = getFirestore(); // Firestore client
const app = express();

// --- 3. MIDDLEWARE & CORS ---

// Vercel Serverless needs body parser explicitly
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(FLASK_SECRET_KEY)); // Use the Flask key to sign cookies

// CORS Configuration (Matching Python)
app.use(cors({
    origin: PROD_FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true, // Crucial for sending session cookies
}));

// --- 4. GEO & SPOTIFY HELPERS (Replicating Python Logic) ---

/** Calculates the distance between two points in km (Haversine Formula) */
const haversine = (lat1, lon1, lat2, lon2) => {
    [lat1, lon1, lat2, lon2] = [lat1, lon1, lat2, lon2].map(deg => deg * (Math.PI / 180));
    const dLon = lon2 - lon1;
    const dLat = lat2 - lat1;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.asin(Math.sqrt(a));
    return c * EARTH_RADIUS_KM;
};

/** Utility to generate Spotify Auth URL */
const getSpotifyAuthUrl = () => {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: SPOTIPY_CLIENT_ID,
        scope: SCOPE,
        redirect_uri: SPOTIPY_REDIRECT_URI,
        show_dialog: 'true',
    });
    return `https://accounts.spotify.com/authorize?${params.toString()}`;
};

/** Utility to get access/refresh tokens */
const getTokens = async (code) => {
    const authString = Buffer.from(`${SPOTIPY_CLIENT_ID}:${SPOTIPY_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIPY_REDIRECT_URI,
    });
    
    const response = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    return response.data;
};

// --- 5. ROUTE IMPLEMENTATION ---

app.get('/login', (req, res) => {
    res.redirect(getSpotifyAuthUrl());
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Error: No code provided.');

    try {
        const tokenData = await getTokens(code);
        const accessToken = tokenData.access_token;

        const userProfileResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const spotifyId = userProfileResponse.data.id;

        // Save tokens to Firestore
        await db.collection('users').doc(spotifyId).set({
            spotify_access_token: tokenData.access_token,
            spotify_refresh_token: tokenData.refresh_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000),
            last_updated: FieldValue.serverTimestamp(),
            location_sharing_enabled: true, // Default to true
        }, { merge: true });

        // Set session cookie (crucial for Flask/Express handoff)
        // Note: Express sessions are generally used, but using cookies for simplicity here
        res.cookie('spotify_id', spotifyId, { 
            signed: true, 
            httpOnly: true, 
            secure: true, 
            sameSite: 'none', 
        });

        res.redirect(PROD_FRONTEND_URL);
    } catch (error) {
        console.error('Spotify/Token Error:', error.message);
        res.status(500).send('Authentication Failed.');
    }
});

app.post('/users/nearby', async (req, res) => {
    const spotifyId = req.signedCookies.spotify_id;
    if (!spotifyId) return res.status(401).json({ error: 'Authentication required' });

    try {
        const { latitude: centerLat, longitude: centerLon, radius_km: radiusKm = 5 } = req.body;
        
        // 1. DYNAMIC PRECISION CALCULATION (Matching Python logic)
        let precision;
        if (radiusKm <= 2.5) precision = 6;
        else if (radiusKm <= 20) precision = 5;
        else if (radiusKm <= 80) precision = 4;
        else if (radiusKm <= 600) precision = 3;
        else precision = 2;

        const currentGeohash = ngeohash.encode(centerLat, centerLon, precision);
        const searchHashes = ngeohash.neighbors(currentGeohash);
        searchHashes.push(currentGeohash); // Include center cell
        
        const nearbyUsersData = [];

        for (const hashPrefix of searchHashes) {
            // Note: Querying is complex in JS; this iterates over hash prefixes
            const snapshot = await db.collection('users')
                .where('geohash', '>=', hashPrefix)
                .where('geohash', '<=', hashPrefix + '~')
                .where('location_sharing_enabled', '==', true)
                .get();

            snapshot.docs.forEach(doc => {
                const user = doc.data();
                if (doc.id === spotifyId || !user.latitude || !user.longitude) return;

                const distance = haversine(centerLat, centerLon, user.latitude, user.longitude);
                
                if (distance <= radiusKm * 1.1) { // 10% buffer
                    // --- FAKE USER SIMULATION ---
                    if (doc.id.includes("fake_user")) {
                        return nearbyUsersData.push({
                            id: doc.id, latitude: user.latitude, longitude: user.longitude,
                            track_name: user.track || 'Simulated Song', artist: user.artist || 'Artist',
                            album_art_url: user.image || '#', user_name: user.user_name || 'Anonymous',
                            spotify_url: "https://open.spotify.com/",
                            track_url: `https://open.spotify.com/search/${encodeURIComponent(user.track)}`,
                        });
                    }

                    // --- REAL USER LOGIC (Simplified: Token Refresh/Fetch Music) ---
                    // In a real Node app, you'd handle token refresh here and fetch current music.
                    // For simplicity, we just return the user's location and name for now, 
                    // assuming the current user's token is valid.
                    
                    return nearbyUsersData.push({
                        id: doc.id, latitude: user.latitude, longitude: user.longitude,
                        track_name: 'Real User Music', artist: 'Real Artist',
                        album_art_url: 'https://placehold.co/64', user_name: user.user_name || 'Spotify User',
                        spotify_url: `https://open.spotify.com/user/${doc.id}`,
                        track_url: 'https://open.spotify.com/search/'
                    });
                }
            });
        }
        res.status(200).json(nearbyUsersData);
    } catch (error) {
        console.error('NEARBY ERROR:', error);
        res.status(500).json({ error: 'Failed to query database.' });
    }
});

// Vercel serverless function export
module.exports = app;