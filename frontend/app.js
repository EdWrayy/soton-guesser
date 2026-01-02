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
//Map of registered player username to player state
let registeredPlayers = new Map();
//list of logged in player usernames (subset of registered players)
let loggedinPlayers = [];

//List of usernames of current admins (subset of logged in players)
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
//Map of player usernames to signal r tokens (who knows if we might need them)
let playerToSignalR = new Map();
//Map of lobby codes to json of match settings (number of rounds, number of players, countdown)
let gameToSettings = new Map();

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
    const playerState = registeredPlayers.get(player);
    const game = playerToGame.get(player);
    const gameState = gameToState.get(game);
    const data = {state: gameState, me: playerState, players: gameToPlayers.get(game)}

    socket.emit('update', data);
}


//Start a session
//Gets lobby code from api function
//Adds a new game at state 0
//Adds the admin (given as parameter)
function startSession(socket, admin, apiResponse) {
    let lobbyCode = apiResponse['matchCode'];
    let token = apiResponse['signalRToken'];
    let matchSettings = apiResponse['matchSettings'];

    //let admin_state = {name : admin, current_score: 0};
    //players.set(admin, admin_state);
    admins.push(admin);
    //playersToSockets.set(admin, socket);
    //socketsToPlayers.set(socket, admin);

    games.push(lobbyCode);
    gameToAdmin.set(lobbyCode, admin);
    gameToPlayers.set(lobbyCode, [admin]);
    gameToState.set(lobbyCode, 0);
    adminToGame.set(admin, lobbyCode);
    playerToGame.set(admin, lobbyCode);

    playerToSignalR.set(admin, token);
    gameToSettings.set(lobbyCode, matchSettings);

    updateAll(lobbyCode);
}

function joinSession(player, game, apiResponse) {
    let token = apiResponse['signalRToken'];

    //let player_state = {name : player, current_score: 0}
    //players.set(player, player_state);
    let otherPlayers = gameToPlayers.get(game);
    gameToPlayers.set(game, otherPlayers.push(player));
    playerToGame.set(player, game);

    playerToSignalR.set(player, token);
}

function register(socket, username, password){
    let player_state = {name: username, password: password, current_score: 0};
    registeredPlayers.set(player, player_state);

    playersToSockets.set(username, socket);
    socketsToPlayers.set(socket, username);
}

function login(socket, username, password){
    if (loggedinPlayers.includes(username)){
        error(socket, "This client is already logged in", false);
    }
    else{
        loggedinPlayers.push(username);
    }
}


function error(socket, message, halt){
    socket.emit("fail", message);
    if (halt){
        socket.disconnect();
    }
}

//API functions
function createLobbyAPI(socket, username){
    request.post(BACKEND_ENDPOINT + '/create_lobby', {
        json: true,
        body: {'username' : username}
    }, function(err, response, body){
        console.log(body)
        if (body['result']){
            startSession(socket, username, body);
        }
        else{
            error(socket, body['msg']);
        }
    })
}

function joinGameAPI(socket, username, game){
    request.post(BACKEND_ENDPOINT + '/join_game', {
        json: true,
        body: {'lobbyCode': game, 'playerId' : username}
    }, function(err, response, body){
        if(body['result']){
            joinSession(username, game, body);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function registerPlayerAPI(socket, username, password){
    request.post(BACKEND_ENDPOINT + '/register', {
        json: true,
        body: {'username' : username, 'password' : password}
    }, function(err, response, body){
        if(body['result']){
            register(socket, username, password);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function loginPlayerAPI(socket, username, password){
    request.post(BACKEND_ENDPOINT + '/login', {
        json: true,
        body: {'username' : username, 'password' : password}
    }, function(err, response, body){
        if(body['result']){
            login(username, password);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

//Handle new connection
io.on('connection', socket => { 
  	console.log('New connection');
    
    //Handle admin starting a new session
    socket.on('start', (username) => {
        createLobbyAPI(socket, username);
    });

    //Handle player joining a game
    socket.on('join', (username, game) => {
        joinGameAPI(socket, username, game);
    });

    //Handle player registering
    socket.on('register', (username, password) => {
        registerPlayerAPI(socket, username, password);
    });

    //Handle player logging in
    socket.on('login', (username, password) => {
        loginPlayerAPI(socket, username, password);
    })
});

//Start server
if (module === require.main) {
  	startServer();
}

module.exports = server;


