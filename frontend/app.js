'use strict';

//set up application
const express = require('express');
const app = express();

//set up sockets
const server = require('http').Server(app);
const io = require('socket.io')(server);
const request = require('request');

//set up signalr
const signalR = require('@microsoft/signalr');


//Setup static page handling
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

//Handle client interface on /
app.get('/', (req, res) => {
    res.render('client');
});

//URL of backend API
const BACKEND_ENDPOINT = process.env.BACKEND || 'https://southampton-guesser-functions-awdkf4e5crf8b8bd.francecentral-01.azurewebsites.net'
const BACKEND_KEY = process.env.BACKEND_KEY || '?==';
const DURABLE_FUNCTIONS_ENDPOINT = process.env.DURABLE_FUNCTIONS_ENDPOINT || 'http://localhost:7071/api/';
const SIGNALR_ENDPOINT = process.env.SIGNALR_ENDPOINT || 'http://localhost:7071/api/';

//Server state
//List of registered player username
let registeredPlayers = []
//map of logged in player usernames (subset of registered players) to player state
let loggedinPlayers = new Map();

//Map of player usernames to player id
let playerToId = new Map();
//Map of player ids to player usernames
let idToPlayer = new Map();

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
//Map of players to player states
//  0     - login
//  1     - main menu
//  2     - in game
//  3     - uploading image
let playerToState = new Map();
//State of the games can be either
//  0     - waiting for players
//  1     - guessing (display image, wait until timer runs out while clients send guesses to redis)
//  2     - image results (also update total scores)
//  3     - leaderboard (end of game)
//states 1 and 2 repeat until all the images have been guessed
//Map of games to states
let gameToState = new Map();
//Map of player usernames to pair of signal r urls and signal r tokens (who knows if we might need them)
let playerToSignalR = new Map();
//Map of lobby codes to json of match settings (number of rounds, number of players, countdown)
let gameToSettings = new Map();
//Map of game to the location currently being displayed
let gameToCurrentLocation = new Map();

//Map of usernames to sockets
let playersToSockets = new Map();
//Map of sockets to usernames
let socketsToPlayers = new Map();

//Map of game lobby code to instance of orchestrator and management urls
//Id: The instance ID of the orchestration (should be the same as the InstanceId input).
//StatusQueryGetUri: The status URL of the orchestration instance.
//SendEventPostUri: The "raise event" URL of the orchestration instance.
//TerminatePostUri: The "terminate" URL of the orchestration instance.
//PurgeHistoryDeleteUri: The "purge history" URL of the orchestration instance.
//suspendPostUri: The "suspend" URL of the orchestration instance.
//resumePostUri: The "resume" URL of the orchestration instance.
let gameToOrchestrator = new Map();
//orchestrator id to game
let orchestratorToGame = new Map();

let orchestratorToSignalURL = new Map();
let orchestratorToConnection = new Map();
let connectionToOrchestrator = new Map()


//Start the server
function startServer() {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

//Advance game state
function advance(game) {
    let state = gameToState.get(game);
    if (state == 0){
        startGameOrchestratorAPI(game);
        updateAll(game);
    }
    else if (state == 1){
        //I am not sure what to put here because this entirely depends on the game orchestrator blessing us with updateLeaderboard
    }
    else if (state == 2){
        startScoring(game);
    }
}

function startGuessing(game, location){
    let players = gameToPlayers.get(game);
    gameToCurrentLocation.set(game, location);
    gameToState.set(game, 1);
    for (let i = 0; i < players.length; i++){
        let socket = playersToSockets.get(players[i]);
        let time = gameToSettings.get(game)['countdown'];
        socket.emit("guess", getState(players[i]), location, time);
    }
}

function startScoring(game){
    let players = gameToPlayers.get(game);
    gameToState.set(game, 3);
    for (let i = 0; i < players.length; i++){
        let socket = playersToSockets.get(players[i]);
        socket.emit("scores", getState(players[i]));
    }
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
    const data = getState(player);
    socket.emit('update', data);
}
//Get the game state
function getState(player){
    const playerState = loggedinPlayers.get(player);
    const game = playerToGame.get(player);
    if (game == null){
        return {state: {currentClientMode: playerToState.get(player)}, isAdmin: false, player: playerState, otherPlayers: []}
    }
    console.log("Getting state for player " + player + " in game " + game);
    const gameState = gameToState.get(game);
    const isAdmin = admins.includes(player);
    const playerMode = playerToState.get(player);
    const playerIndex = gameToPlayers.get(game).indexOf(player);
    const otherPlayers = gameToPlayers.get(game).splice(playerIndex, 1)
    return {state: {currentClientMode: playerMode, gameState: gameState}, isAdmin: isAdmin, player: playerState, otherPlayers: otherPlayers}
}


//Start a session
//Gets lobby code from api function
//Adds a new game at state 0
//Adds the admin (given as parameter)
function startSession(admin, apiResponse) {
    let lobbyCode = apiResponse['matchCode'];
    let signalR = apiResponse['signalR'];
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

    playerToSignalR.set(admin, signalR);
    gameToSettings.set(lobbyCode, matchSettings);

    playerToState.set(admin, 2);
    let adminSocket = playersToSockets.get(admin);
    adminSocket.emit('lobby', getState(admin), lobbyCode)

    updateAll(lobbyCode);
}

function joinSession(player, game, apiResponse) {
    let signalR = apiResponse['signalR'];

    //let player_state = {name : player, current_score: 0}
    //players.set(player, player_state);
    let otherPlayers = gameToPlayers.get(game);
    gameToPlayers.set(game, otherPlayers.push(player));
    playerToGame.set(player, game);

    playerToSignalR.set(player, signalR);

    playerToState.set(player, 2);
    let playerSocket = playersToSockets.get(player);
    playerSocket.emit('lobby', getState(player), game);

    updateAll(game);
}

function register(socket, username, password){
    
    registeredPlayers.push(player);

    playersToSockets.set(username, socket);
    socketsToPlayers.set(socket, username);

    playerToState.set(username, 0);
}

function login(socket, username, password, responseBody){
    if (loggedinPlayers.has(username)){
        error(socket, "This client is already logged in", false);
    }
    else{
        let player_state = {name: username, currentScore: 0, guess: null};
        let userId = responseBody['userId'];
        playerToId.set(username, userId);
        idToPlayer.set(userId, username);
        loggedinPlayers.set(username, player_state);
        playersToSockets.set(username, socket);
        socketsToPlayers.set(socket, username);
        playerToState.set(username, 1);
        console.log("Player " + username + " logged in with id " + userId);
        socket.emit('menu', getState(username));
    }
}

function returnToMenu(socket){
    let player = socketsToPlayers.get(socket);
    if (playerToGame.has(player)){
        let game = playerToGame.get(player);
        leaveGameAPI(socket);
        let playersList = gameToPlayers.get(game);
        let playerIndex = playersList.indexOf(player);
        gameToPlayers.set(game, playersList.splice(playerIndex, 1));
        playerToGame.delete(player);
        playerToSignalR.delete(player);

        if (admins.includes(player)){
            admins.splice(admins.indexOf(player), 1);
            adminToGame.delete(player);
            gameToAdmin.delete(game);
            //Most likely would need functionality to end the game since there is no admin or re-assign a new admin
        }
        updateAll(game);
    }
    playerToState.set(player, 1);
    
}

function startAnswers(game, roundResults){
    let players = gameToPlayers.get(game);
    gameToState.set(game, 2);
    increaseScores(roundResults);
    for (let i = 0; i < players.length; i++){
        var socket = playersToSockets.get(players[i]);
        socket.emit("awnsers", getState(players[i]), roundResults);
    }
}

function increaseScores(roundResults){
    for (let i = 0; i < roundResults.length; i++){
        var result = roundResults[i];
        var player = result['player_id'];
        var score = result['data'];
        var playerState = loggedinPlayers.get(player);
        loggedinPlayers.set(player, {name: playerState['name'], currentScore: (playerState['currentScore'] + score), guess: playerState['guess']});
    }
}

function concludeGame(game){
    var admin = gameToAdmin.get(game);
    var players = gameToPlayers.get(game);
    var orchestrator = gameToOrchestrator.get(game);
    var connection = orchestratorToConnection.get(game);

    if (admin != null){
        adminToGame.delete(admin);
    }
    if (players != null){
        for (let i = 0; i < players.length; i++){
        var player = players[i];
        playerToGame.delete(player);
        }   
    }
    if (connection != null){
        connectionToOrchestrator.delete(connection);
    }
    if (orchestrator != null){
        orchestratorToConnection.delete(orchestrator);
    }

    gameToAdmin.delete(game);
    gameToPlayers.delete(game);
    gameToOrchestrator.delete(game);
    gameToCurrentLocation.delete(game);
    gameToSettings.delete(game);
    gameToState.delete(game);
}


function error(socket, message, halt){
    socket.emit("fail", message);
    if (halt){
        socket.disconnect();
    }
}

//API functions
function createLobbyAPI(socket, username){
    var userId = playerToId.get(username);
    request.post(BACKEND_ENDPOINT + '/create_lobby', {
        json: true,
        body: {'userId' : userId}
    }, function(err, response, body){
        console.log(body)
        if (body['result']){
            startSession(username, body);
        }
        else{
            error(socket, body['msg']);
        }
    })
}

function joinGameAPI(socket, username, game){
    var playerId = playerToId.get(username);
    request.post(BACKEND_ENDPOINT + '/join_game', {
        json: true,
        body: {'lobbyCode': game, 'playerId' : playerId}
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
    request.post(BACKEND_ENDPOINT + '/register' + BACKEND_KEY, {
        json: true,
        body: {'username' : username, 'password' : password}
    }, function(err, response, body){
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (response.statusCode !== 200 && response.statusCode !== 201){
            error(socket, "Registration failed with status code " + response.statusCode, false);
            return;
        }
        if(body['result']){
            register(socket, username, password);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function loginPlayerAPI(socket, username, password){
    request.post(BACKEND_ENDPOINT + '/login' + BACKEND_KEY, {
        json: true,
        body: {'username' : username, 'password' : password}
    }, function(err, response, body){
        console.log(body)
        if (err){
            error(socket, "Something went wrong when contacting the backend", false);
            return;
        }
        if (response.statusCode !== 200){
            error(socket, "Login failed with status code " + response.statusCode, false);
            return;
        }
        console.log("Player " + username + " logged in with id " + body['userId']);
        console.log(body);
        if(body['result']){
            login(socket, username, password, body);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function uploadImageAPI(socket, data){
    request.post(BACKEND_ENDPOINT + '/create_place', {
        json: true,
        body: data
    }, function(err, response, body){
        if(body['result']){
            console.log("Image successfully uploaded at: " + body['url']);
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function leaveGameAPI(socket){
    var player = socketsToPlayers.get(socket);
    var playerId = playerToId.get(player);
    var game = playerToGame.get(player);
    request.post(BACKEND_ENDPOINT + '/quit_game', {
        json: true,
        body: {'matchCode' : game, 'playerId' : playerId} 
    }, function(err, response, body){
        if(body['result']){
            console.log("Left game in the backend");
        }
        else{
            error(socket, body['msg'], false);
        }
    })
}

function updateLeaderboardAPI(socket, timeframe){
    let response = request.get(BACKEND_ENDPOINT + '/leaderboard', params={'scope' : timeframe, 'limit' : 10});
    let response_json = response.json();
    if (response_json['result']){
        socket.emit('leaderboard', response_json['items']);
    }
    else{
        error(socket, "Something went impossibly wrong", false);
    }
}

function makeGuessAPI(socket, guess){
    let player = socketsToPlayers.get(socket);
    let playerId = playerToId.get(player);
    let game = playerToGame.get(player);
    let actualLoc = gameToCurrentLocation.get(game);
    let actualCoord = actualLoc['location'];

    request.post(BACKEND_ENDPOINT + '/guess', {
        json: true,
        body: {'matchCode' : game, 'playerId' : playerId, 'guess' : guess}
    }, function(err, response, body){
        if(body['result']){
            console.log("Guess successfully sent");
        }
        else{
            console.log("Something went wrong went guessing");
        }
    })
}

function getLocationAPI(locationId){
    let response = request.get(BACKEND_ENDPOINT + '/get_place', params={'id' : locationId});
    let response_json = response.json();
    if (response_json['result']){
        return response_json['place'];
    }
    else{
        throw new Error("Error in get location");
    }
}

function resultsAPI(game){
    request.post(BACKEND_ENDPOINT + '/results', {
        json: true, 
        body: {'matchCode' : game}
    }, function(err, response, body){
        if(body['result']){
            concludeGame(game);
        }
        else{
            console.log(body['msg']);
        }
    })
}

function startGameOrchestratorAPI(game){
    var settings = gameToSettings.get(game);
    var numRounds = settings['noOfRounds'];
    var timeRounds = settings['countdown'];

    request.post(BACKEND_ENDPOINT + '/start_game_trigger', {
        json: true,
        body: {'gameId' : game, 'rounds' : numRounds, 'time' : timeRounds}
    }, function(err, response, body){
        if (response.statusCode == 202){
            var orchestratorId = body['Id'];
            gameToOrchestrator.set(game, body);
            orchestratorToGame.set(orchestratorId, game);
            orchestratorToSignalURL.set(orchestratorId, "This is where the URL will go");

            const connection = new signalR.HubConnectionBuilder().withUrl(orchestratorToSignalURL.get(orchestratorId)).build();

            //Handle signalR signals
            //Handle new round
            connection.on("newRound", (data) => {
                var locationId = data[1];
                var gameId = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                try {
                    var location = getLocationAPI(locationId);
                    startGuessing(gameId, location);
                }
                catch(err){
                    console.log("Something went wrong when getting location");
                }

            })

            connection.on("endRound", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                var players = gameToPlayers.get(game);
                for (let i = 0; i < players.length; i++){
                    var socket = playersToSockets.get(players[i]);
                    socket.emit("roundEnd");
                }
            })

            connection.on("updateLeaderboard", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                var roundResults = data[0];
                startAnswers(game, roundResults);
                
            })

            connection.on("gameOver", (data) => {
                var game = orchestratorToGame.get(connectionToOrchestrator.get(connection));
                resultsAPI(game);
            })
            
            orchestratorToConnection.set(orchestratorId, connection);
            connectionToOrchestrator.set(connection, orchestratorId);
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
    });

    //Handle player returning to menu
    socket.on('menu', ()=> {
        returnToMenu(socket);
    });

    //Handle player entering image upload state
    socket.on('toUpload', () => {
        let player = socketsToPlayers.get(socket);
        playerToState.set(player, 3);
        socket.emit('upload', getState(player));
    });

    //Handle client uploading image
    socket.on('upload', (data) => {
        uploadImageAPI(socket, data);
    });

    //Handle leaderboard request
    socket.on('leaderboard', (timeframe) => {
        updateLeaderboardAPI(socket, timeframe);
    });

    //Handle guesses
    socket.on('guess', (guessLoc) => {
        makeGuessAPI(socket, guessLoc)
    });

    socket.on('advance', () => {
        var player = socketsToPlayers.get(socket);
        var game = playerToGame.get(player);
        advance(game);
    })
});

//Start server
if (module === require.main) {
  	startServer();
}

module.exports = server;


