'use strict';

//set up application
const express = require('express');
const app = express();

//set up sockets
const server = require('http').Server(app);
const io = require('socket.io')(server);
const request = require('request');


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
let gameToAdmin = new Map();
//Map of admins to games 
let adminToGame = new Map();
//Map of currently ongoing games to players (includes admins)
let gameToPlayers = new Map();
//Map of players to games
let playerToGame = new Map();
//State of the games can be either
//  0     - waiting for players
//  1     - guessing (display image, wait until timer runs out while clients send guesses to redis)
//  2     - image results (also update total scores)
//  3     - leaderboard (end of game)
//states 1 and 2 repeat until all the images have been guessed
//Map of games to states
let gameToState = new Map();

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

//Update all clients
function updateAll(game){
    for (let [player] of gameToPlayers.get(game)){
        updateClient(player)
    }
}
//Update one client
function updateClient(player){
    const socket = playersToSockets.get(player);
    const playerState = players.get(player);
    const game = playerToGame.get(player);
    const gameState = gameToState.get(game);
    const data = {state: gameState, me: playerState, players: gameToPlayers.get(game)}

    socket.emit('update', data);
}

//Start a session
//Generates a random lobby code
//Adds a new game at state 0
//Adds the admin (given as parameter)
function startSession(socket, admin, adminPicture) {
    let admin_state = {name : admin, picture: adminPicture, current_score: 0};
    players.set(admin, admin_state);
    admins.push(admin);
    playersToSockets.set(admin, socket);
    socketsToPlayers.set(socket, admin);

    let lobbyCode = -1;
    do {
        lobbyCode = Math.floor(Math.random() * 9999);
    } while (games.includes(lobbyCode));

    games.push(lobbyCode);
    gameToAdmin.set(lobbyCode, admin);
    gameToPlayers.set(lobbyCode, [admin]);
    gameToState.set(lobbyCode, 0);
    adminToGame.set(admin, lobbyCode);
    playerToGame.set(admin, lobbyCode);

    updateAll(lobbyCode);
}

function joinSession(socket, player, playerPicture, game) {
    let player_state = {name : player, picture: playerPicture, current_score: 0}
    players.set(player, player_state);
    let otherPlayers = gameToPlayers.get(game);
    gameToPlayers.set(game, otherPlayers.push(player));
    playerToGame.set(player, game);

    playersToSockets.set(player, socket);
    socketsToPlayers.set(socket, player);
}

//Handle new connection
io.on('connection', socket => { 
  	console.log('New connection');
    
    //Handle admin starting a new session
    socket.on('start', (username, picture) => {
        startSession(socket, username, picture);
    });

    //Handle player joining a game
    socket.on('join', (username, picture, game) => {
        joinSession(socket, username, picture, game);
    });
});

//Start server
if (module === require.main) {
  	startServer();
}

module.exports = server;


