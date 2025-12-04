import React from 'react';

// Automatically use '/api' in production, or localhost in development
const BACKEND_URL = import.meta.env.PROD 
  ? '/api' // Production uses relative path
  : 'http://127.0.0.1:5000'; // Development uses absolute path
const LoginButton = () => {
    const handleLogin = () => {
        window.location.href = `${BACKEND_URL}/login`;
    };

    return (
        <div className="login-container">
            <div className="login-glass">
                <h1 style={{ fontSize: '3rem', margin: '0 0 10px 0' }}>SpotiMap</h1>
                <p style={{ fontSize: '1.2rem', marginBottom: '30px', color: '#ccc' }}>
                    Discover the soundtrack of your city.
                </p>
                <button
                    onClick={handleLogin}
                    className="toggle-btn"
                    style={{ fontSize: '1.2rem', padding: '15px 40px', borderRadius: '50px', boxShadow: '0 0 20px rgba(29, 185, 84, 0.4)' }}
                >
                    Connect with Spotify
                </button>
                <p style={{ marginTop: '20px', fontSize: '0.9rem', opacity: 0.7 }}>
                    <span style={{ display: 'block', marginBottom: '5px' }}>📍 Location access required</span>
                    🎵 Spotify Premium recommended
                </p>
            </div>
        </div>
    );
};

export default LoginButton;