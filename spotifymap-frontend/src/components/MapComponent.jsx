import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import useSWR from 'swr';

// Automatically use '/api' in production, or localhost in development
const BACKEND_URL = import.meta.env.PROD 
  ? '/api' // Production uses relative path
  : 'http://127.0.0.1:5000'; // Development uses absolute path
// --- FETCHERS ---
const fetcherGet = (url) => axios.get(url, { withCredentials: true }).then((res) => res.data);
const fetcherPost = ([url, lat, lon, rad]) =>
    axios.post(url, { latitude: lat, longitude: lon, radius_km: rad }, { withCredentials: true }).then((res) => res.data);

// --- 1. OPTIMIZED MARKER COMPONENT ---
const UserMarker = React.memo(({ user, isMe }) => {
    const glassIcon = useMemo(() => {
        const imgUrl = user.album_art_url || 'https://cdn-icons-png.flaticon.com/512/3209/3209995.png';
        return L.divIcon({
            className: 'custom-pin',
            html: `<div class="pin-outer"><div class="pin-inner"><img src="${imgUrl}" alt="Music" /></div></div>`,
            iconSize: [50, 50],
            iconAnchor: [25, 25],
            popupAnchor: [0, -30]
        });
    }, [user.album_art_url]);

    return (
        <Marker position={[user.latitude, user.longitude]} icon={glassIcon}>
            <Popup>
                <div style={{ textAlign: 'center', minWidth: '160px' }}>
                    {/* Header */}
                    <div style={{
                        fontSize: '0.7rem',
                        letterSpacing: '1px',
                        marginBottom: '8px',
                        color: '#888',
                        borderBottom: '1px solid rgba(255,255,255,0.1)',
                        paddingBottom: '5px'
                    }}>
                        {isMe ? 'YOU ARE LISTENING TO' : user.user_name?.toUpperCase()}
                    </div>

                    {/* Album Art Link */}
                    <a href={user.track_url} target="_blank" rel="noopener noreferrer">
                        <img src={user.album_art_url} className="popup-art" alt="Art" />
                    </a>

                    {/* Track Info */}
                    <div style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '2px' }}>
                        {user.track_name}
                    </div>

                    {/* ARTIST NAME LINK */}
                    <div style={{ fontSize: '0.9rem' }}>
                        <a
                            href={user.artist_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="artist-link"
                        >
                            {user.artist}
                        </a>
                    </div>

                    {/* Follow Button */}
                    {!isMe && (
                        <a
                            href={user.spotify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="follow-btn"
                        >
                            Follow on Spotify
                        </a>
                    )}
                </div>
            </Popup>
        </Marker>
    );
});

// --- HELPER TO CALCULATE RADIUS ---
const getMapRadius = (map) => {
    const bounds = map.getBounds();
    const center = bounds.getCenter();
    const northEast = bounds.getNorthEast();
    return center.distanceTo(northEast) / 1000;
};

// --- MAP EVENTS HANDLER ---
function MapEventHandler({ setViewState }) {
    const map = useMap();

    useEffect(() => {
        setViewState({ lat: map.getCenter().lat, lng: map.getCenter().lng, radius: getMapRadius(map) });

        const onMove = () => {
            setViewState({
                lat: map.getCenter().lat,
                lng: map.getCenter().lng,
                radius: getMapRadius(map)
            });
        };
        map.on('moveend', onMove);
        return () => map.off('moveend', onMove);
    }, [map, setViewState]);

    return null;
}

const MapComponent = () => {
    const [userLocation, setUserLocation] = useState(null);
    const [viewState, setViewState] = useState(null);
    const [sharingEnabled, setSharingEnabled] = useState(true);
    const [darkMode, setDarkMode] = useState(true);

    useEffect(() => { document.body.className = darkMode ? 'dark-mode' : 'light-mode'; }, [darkMode]);

    useEffect(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude }),
                () => setUserLocation({ lat: 40.7128, lng: -74.0060 }),
                { enableHighAccuracy: true }
            );
        }
    }, []);

    useEffect(() => {
        if (userLocation) {
            const pushLocation = async () => {
                const formData = new URLSearchParams();
                formData.append('lat', userLocation.lat);
                formData.append('lon', userLocation.lng);
                formData.append('sharing', sharingEnabled ? 'on' : 'off');
                try {
                    await axios.post(`${BACKEND_URL}/me/update-location`, formData.toString(), {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, withCredentials: true
                    });
                } catch (e) { }
            };
            pushLocation();
            const interval = setInterval(pushLocation, 10000);
            return () => clearInterval(interval);
        }
    }, [userLocation, sharingEnabled]);

    const { data: myTrack } = useSWR(`${BACKEND_URL}/now-playing`, fetcherGet, {
        refreshInterval: 5000, keepPreviousData: true
    });

    const { data: nearbyUsers } = useSWR(
        (viewState) ? [`${BACKEND_URL}/users/nearby`, viewState.lat, viewState.lng, viewState.radius] : null,
        fetcherPost,
        { refreshInterval: 10000, keepPreviousData: true }
    );

    if (!userLocation) return <div className="login-container"><h1>Locating...</h1></div>;

    const tileUrl = darkMode
        ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

    return (
        <div style={{ position: 'relative', height: '100vh', width: '100vw' }}>

            {/* Controls */}
            <div className="glass-panel">
                <h2 style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '10px' }}>
                    SpotiMap <span style={{ color: 'var(--spotify-green)' }}>Live</span>
                </h2>
                <div className="controls">
                    <div className="switch-container">
                        <span>Broadcast Location</span>
                        <label className="switch">
                            <input type="checkbox" checked={sharingEnabled} onChange={(e) => setSharingEnabled(e.target.checked)} />
                            <span className="slider"></span>
                        </label>
                    </div>
                    <div className="switch-container">
                        <span>{darkMode ? 'Dark Mode 🌙' : 'Light Mode ☀️'}</span>
                        <label className="switch">
                            <input type="checkbox" checked={darkMode} onChange={(e) => setDarkMode(e.target.checked)} />
                            <span className="slider"></span>
                        </label>
                    </div>
                </div>
            </div>

            {/* Map */}
            <MapContainer center={userLocation} zoom={15} zoomControl={false} style={{ height: '100%', width: '100%', background: darkMode ? '#000' : '#ddd' }}>
                <TileLayer attribution='© CARTO' url={tileUrl} />
                <MapEventHandler setViewState={setViewState} />

                {/* MY PIN */}
                {myTrack && myTrack.is_playing && (
                    <UserMarker
                        user={{
                            latitude: userLocation.lat,
                            longitude: userLocation.lng,
                            album_art_url: myTrack.album_art_url,
                            track_name: myTrack.track_name,
                            artist: myTrack.artist,
                            track_url: myTrack.track_url,
                            artist_url: myTrack.artist_url // Pass the URL here too
                        }}
                        isMe={true}
                    />
                )}

                {/* NEARBY USERS */}
                {nearbyUsers && nearbyUsers.map((user) => (
                    <UserMarker key={user.id} user={user} isMe={false} />
                ))}

            </MapContainer>
        </div>
    );
};

export default MapComponent;