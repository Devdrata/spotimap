# api/index.py
import os
import json
import math
import urllib.parse
from flask import Flask, redirect, request, session, url_for, jsonify
from spotipy.oauth2 import SpotifyOAuth
import spotipy
# dotenv is not needed in production Vercel environment, but good for local
from dotenv import load_dotenv 
import pygeohash as pgh
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore

# Load local .env if it exists (for local development)
load_dotenv()

app = Flask(__name__)

# --- 1. DYNAMIC CONFIGURATION ---
# In Production, Vercel provides the URL. Locally, we use 127.0.0.1:5173
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://127.0.0.1:5173")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev_secret_key")

app.secret_key = FLASK_SECRET_KEY

# CORS: Allow the dynamic Frontend URL
CORS(app, supports_credentials=True, origins=[FRONTEND_URL])

SPOTIPY_CLIENT_ID = os.environ.get("SPOTIPY_CLIENT_ID")
SPOTIPY_CLIENT_SECRET = os.environ.get("SPOTIPY_CLIENT_SECRET")
# In Prod, this must be set to https://YOUR-APP.vercel.app/api/callback
SPOTIPY_REDIRECT_URI = os.environ.get("SPOTIPY_REDIRECT_URI") 
SCOPE = "user-read-currently-playing user-read-private"
EARTH_RADIUS_KM = 6371

# --- 2. FIREBASE INITIALIZATION (Env Var or File) ---
try:
    # Check for Production Env Var (JSON String)
    firebase_json = os.environ.get("FIREBASE_CREDENTIALS")
    
    if not firebase_admin._apps:
        if firebase_json:
            # Production: Load from Environment Variable String
            cred_dict = json.loads(firebase_json)
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)
        elif os.path.exists("../firebase-key.json"):
            # Local Dev: Load from file in root
            cred = credentials.Certificate("../firebase-key.json")
            firebase_admin.initialize_app(cred)
        else:
            print("Warning: No Firebase credentials found.")
            
    db = firestore.client()
except Exception as e:
    print(f"Error initializing Firebase: {e}")

# --- Helper Functions (Keep exactly as before) ---
def get_spotify_oauth():
    return SpotifyOAuth(
        client_id=SPOTIPY_CLIENT_ID,
        client_secret=SPOTIPY_CLIENT_SECRET,
        redirect_uri=SPOTIPY_REDIRECT_URI,
        scope=SCOPE,
        show_dialog=True
    )

def haversine(lat1, lon1, lat2, lon2):
    lon1, lat1, lon2, lat2 = map(math.radians, [lon1, lat1, lon2, lat2])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    c = 2 * math.asin(math.sqrt(a))
    return c * EARTH_RADIUS_KM

def get_all_neighbors(geohash):
    neighbors = [geohash]
    n = pgh.get_adjacent(geohash, 'top')
    s = pgh.get_adjacent(geohash, 'bottom')
    e = pgh.get_adjacent(geohash, 'right')
    w = pgh.get_adjacent(geohash, 'left')
    neighbors.extend([n, s, e, w])
    nw = pgh.get_adjacent(n, 'left')
    ne = pgh.get_adjacent(n, 'right')
    sw = pgh.get_adjacent(s, 'left')
    se = pgh.get_adjacent(s, 'right')
    neighbors.extend([nw, ne, sw, se])
    return list(set(neighbors))

def save_user_data(spotify_id, token_info, location=None, is_sharing=False):
    user_ref = db.collection('users').document(spotify_id)
    data_to_set = {
        'spotify_access_token': token_info['access_token'],
        'spotify_refresh_token': token_info['refresh_token'],
        'expires_at': token_info['expires_at'],
        'last_updated': firestore.SERVER_TIMESTAMP,
        'location_sharing_enabled': is_sharing,
    }
    if location and location['lat'] is not None and location['lon'] is not None:
        data_to_set['latitude'] = location['lat']
        data_to_set['longitude'] = location['lon']
        data_to_set['geohash'] = pgh.encode(location['lat'], location['lon'], precision=7)
    
    user_ref.set(data_to_set, merge=True)

def get_token_info(spotify_id):
    user_ref = db.collection('users').document(spotify_id)
    user_doc = user_ref.get()
    if not user_doc.exists: return None
    data = user_doc.to_dict()
    token_info = {
        'access_token': data.get('spotify_access_token'),
        'refresh_token': data.get('spotify_refresh_token'),
        'expires_at': data.get('expires_at'),
        'scope': SCOPE,
        'token_type': 'Bearer'
    }
    sp_oauth = get_spotify_oauth()
    if sp_oauth.is_token_expired(token_info):
        try:
            new_token_info = sp_oauth.refresh_access_token(token_info['refresh_token'])
            is_sharing = data.get('location_sharing_enabled', False)
            location = {'lat': data.get('latitude'), 'lon': data.get('longitude')} if data.get('latitude') else None
            save_user_data(spotify_id, new_token_info, location=location, is_sharing=is_sharing)
            token_info = new_token_info
        except Exception as e:
            return None
    return token_info['access_token']

# --- Routes ---

@app.route('/')
def index():
    return jsonify({'status': 'Backend Running', 'frontend': FRONTEND_URL})

@app.route('/login')
def login():
    sp_oauth = get_spotify_oauth()
    return redirect(sp_oauth.get_authorize_url())

@app.route('/callback')
def callback():
    sp_oauth = get_spotify_oauth()
    code = request.args.get('code')
    if code:
        token_info = sp_oauth.get_access_token(code)
        sp = spotipy.Spotify(auth=token_info['access_token'])
        spotify_id = sp.current_user()['id']
        save_user_data(spotify_id, token_info)
        session['spotify_id'] = spotify_id
        # REDIRECT TO PRODUCTION FRONTEND
        return redirect(FRONTEND_URL)
    return 'Error: No code provided.', 400

@app.route('/now-playing')
def now_playing():
    spotify_id = session.get('spotify_id')
    if not spotify_id: return jsonify({'error': 'Not logged in'}), 401
    access_token = get_token_info(spotify_id)
    if not access_token: return jsonify({'error': 'Token expired'}), 401
    try:
        sp = spotipy.Spotify(auth=access_token)
        current_track = sp.current_user_playing_track()
        if not current_track or not current_track.get('is_playing'):
            return jsonify({'is_playing': False})
        artist_url = "#"
        if current_track['item']['artists']:
             artist_url = current_track['item']['artists'][0]['external_urls']['spotify']
        return jsonify({
            'is_playing': True,
            'track_name': current_track['item']['name'],
            'artist': current_track['item']['artists'][0]['name'],
            'album_art_url': current_track['item']['album']['images'][0]['url'],
            'track_url': current_track['item']['external_urls']['spotify'],
            'artist_url': artist_url
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/me/update-location', methods=['POST'])
def update_location():
    spotify_id = session.get('spotify_id')
    if not spotify_id: return {'error': 'Not logged in'}, 401
    lat = request.form.get('lat')
    lon = request.form.get('lon')
    is_sharing = request.form.get('sharing') == 'on'
    location_data = {'lat': float(lat), 'lon': float(lon)} if lat and lon else None
    user_ref = db.collection('users').document(spotify_id)
    if user_ref.get().exists:
        data_to_update = {
            'location_sharing_enabled': is_sharing,
            'last_updated': firestore.SERVER_TIMESTAMP
        }
        if location_data:
            data_to_update['latitude'] = location_data['lat']
            data_to_update['longitude'] = location_data['lon']
            data_to_update['geohash'] = pgh.encode(location_data['lat'], location_data['lon'], precision=7)
        user_ref.update(data_to_update)
        return {'status': 'success'}
    return {'error': 'User not found'}, 404

@app.route('/users/nearby', methods=['POST'])
def users_nearby():
    spotify_id = session.get('spotify_id')
    if not spotify_id: return jsonify({'error': 'Auth required'}), 401
    try:
        data = request.get_json() 
        center_lat = float(data['latitude'])
        center_lon = float(data['longitude'])
        radius_km = float(data.get('radius_km', 5)) 
    except Exception as e:
        return jsonify({'error': str(e)}), 400

    if radius_km <= 2.5: precision = 6
    elif radius_km <= 20: precision = 5
    elif radius_km <= 80: precision = 4
    elif radius_km <= 600: precision = 3
    else: precision = 2

    current_geohash = pgh.encode(center_lat, center_lon, precision=precision)
    search_hashes = get_all_neighbors(current_geohash)
    nearby_users_data = []

    for hash_prefix in search_hashes:
        query = db.collection('users').where('geohash', '>=', hash_prefix).where('geohash', '<=', hash_prefix + '~').where('location_sharing_enabled', '==', True)
        docs = query.stream()
        for doc in docs:
            user_data = doc.to_dict()
            if doc.id == spotify_id: continue
            if 'latitude' not in user_data or 'longitude' not in user_data: continue
            distance = haversine(center_lat, center_lon, user_data['latitude'], user_data['longitude'])
            if distance <= (radius_km * 1.1):
                nearby_user_id = doc.id
                if "fake_user" in nearby_user_id:
                     track_name = user_data.get('track', 'Song')
                     artist_name = user_data.get('artist', 'Artist')
                     encoded_query = urllib.parse.quote(f"{track_name} {artist_name}")
                     fake_track_url = f"https://open.spotify.com/search/{encoded_query}"
                     encoded_artist = urllib.parse.quote(artist_name)
                     fake_artist_url = f"https://open.spotify.com/search/{encoded_artist}&type=artist"
                     nearby_users_data.append({
                        'id': nearby_user_id,
                        'latitude': user_data['latitude'],
                        'longitude': user_data['longitude'],
                        'track_name': track_name,
                        'artist': artist_name,
                        'album_art_url': user_data.get('image', 'https://cdn-icons-png.flaticon.com/512/3209/3209995.png'),
                        'user_name': user_data.get('user_name', 'Anonymous'),
                        'spotify_url': "https://open.spotify.com/",
                        'track_url': fake_track_url,
                        'artist_url': fake_artist_url
                    })
                     continue
                access_token = get_token_info(nearby_user_id)
                if access_token:
                    sp = spotipy.Spotify(auth=access_token)
                    try:
                        try:
                            user_profile = sp.current_user()
                            real_name = user_profile.get('display_name', 'Spotify User')
                            profile_url = user_profile['external_urls']['spotify']
                        except:
                            real_name = 'Spotify User'
                            profile_url = "#"
                        track = sp.current_user_playing_track()
                        if track and track.get('is_playing'):
                            artist_url = "#"
                            if track['item']['artists']:
                                artist_url = track['item']['artists'][0]['external_urls']['spotify']
                            nearby_users_data.append({
                                'id': nearby_user_id,
                                'latitude': user_data['latitude'],
                                'longitude': user_data['longitude'],
                                'track_name': track['item']['name'],
                                'artist': track['item']['artists'][0]['name'],
                                'album_art_url': track['item']['album']['images'][0]['url'],
                                'track_url': track['item']['external_urls']['spotify'],
                                'artist_url': artist_url,
                                'user_name': real_name,
                                'spotify_url': profile_url
                            })
                    except Exception: pass
    return jsonify(nearby_users_data)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(FRONTEND_URL)

# Vercel handles the execution, so app.run is not needed for production