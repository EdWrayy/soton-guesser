'use strict';

//set up application
const express = require('express');
const app = express();

//set up sockets
const server = require('http').Server(app);
const io = require('socket.io')(server);
const request = require('requrest');


//Setup static page handling
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

//Handle client interface on /
app.get('/', (req, res) => {
    res.render('client');
});

//URL of backend API
const BACKEND_ENDPOINT = process.env.BACKEND || 'http://localhost:8181';

//Server state
//Map of player username to player state
let players = new Map();

//List of usernames of current admins
let admins = [];
//List of current games by lobby code
let games = [];
//Map of currently ongoing games to admins
let gamesToAdmins = new Map();
//Map of currently ongoing games to players (includes admins)
let gamesToPlayers = new Map();

//Map of usernames to sockets
let playersToSockets = new Map();
//Map of sockets to usernames
let socketsToPlayers = new Map();

//Start the server
function startServer() {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

//Handle new connection
io.on('connection', socket => { 
  	console.log('New connection');
});

//Start server
if (module === require.main) {
  	startServer();
}

module.exports = server;


