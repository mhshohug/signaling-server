// Load environment variables
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');

const logger = require('./utils/logger');
const { socketAuthMiddleware } = require('./middleware/auth');
const { initSocket } = require('./socket');
const { getIceServers } = require('./config/iceServers');

const app = express();
const server = http.createServer(app);

// Configure CORS
const corsOrigins = process.env.CORS_ORIGIN || '*';
const corsOptions = {
  origin: corsOrigins === '*' ? '*' : corsOrigins.split(',').map(o => o.trim()),
  methods: ['GET', 'POST'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// HTTP Request logging
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.http(message.trim()) }
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'production',
    uptime: process.uptime()
  });
});

// REST API endpoint to retrieve ICE (STUN/TURN) servers configured on the server
app.get('/ice-servers', (req, res) => {
  try {
    const servers = getIceServers();
    res.status(200).json({
      success: true,
      iceServers: servers
    });
  } catch (error) {
    logger.error(`Error fetching ICE servers via REST: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve ICE servers'
    });
  }
});

// Configure Socket.IO Server
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: 30000, // 30 seconds
  pingInterval: 15000, // 15 seconds
  transports: ['websocket', 'polling']
});

// Attach Authentication Middleware
io.use(socketAuthMiddleware);

// Initialize Socket Signaling routes
initSocket(io);

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`WebRTC Signaling Server running on port ${PORT} in ${process.env.NODE_ENV || 'production'} mode`);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  // Close the socket connections cleanly
  io.close(() => {
    logger.info('Socket.IO connections closed.');
    
    // Close HTTP server
    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
  });

  // Force shutdown if taking too long
  setTimeout(() => {
    logger.error('Shutdown took too long, forcing exit...');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
