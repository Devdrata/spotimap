// src/App.jsx
import React, { useState, useEffect } from 'react';
import MapComponent from './components/MapComponent';
import LoginButton from './components/LoginButton';
import axios from 'axios';
import './App.css';

const BACKEND_URL = 'http://127.0.0.1:5000';

function App() {
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Check if the user is authenticated by hitting the Flask '/' route
    useEffect(() => {
        // We must enable withCredentials to send the Flask session cookie
        axios.get(BACKEND_URL, { withCredentials: true })
            .then(response => {
                // If the Flask server returns the "Logged In!" HTML, the session is active.
                if (response.data.includes('Logged In!')) {
                    setIsLoggedIn(true);
                } else {
                    setIsLoggedIn(false);
                }
            })
            .catch(() => {
                // If the request fails (e.g., server down or 401/404), assume logged out
                setIsLoggedIn(false);
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, []);

    if (isLoading) {
        return <div style={{ padding: '50px', textAlign: 'center' }}>Checking login status...</div>;
    }

    return (
        <div className="App">
            {isLoggedIn ? <MapComponent /> : <LoginButton />}
        </div>
    );
}

export default App;