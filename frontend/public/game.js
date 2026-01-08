var socket = null;

let map = null;
const maxFileSize = 1000000;
let timerId = null;

//Prepare game
var app = new Vue({
    el: '#game',
    data: {
        connected: false,
        disconnected: false,
        state: {state: {currentClientMode: 0, gameState: 0}, isAdmin: true, player: {name: "me", currentScore: 0, guess: null}, otherPlayers: []},
        leaderboard: null,
        registering: false,
        username: "",
        password: "",
        confirmPassword: "",
        showPassword: false,
        showConfirmPassword: false,
        code: "",
        errorMessage: "",
        infoMessage: "",
        awnsered: false,
        mapMarkers: [],
        file: null,
        lat: "",
        lng: "",
        locName: "",
        timerText: "",
        guessTime: 0,
        location: null,
    },
    mounted: function() {
        connect(); 
    },
    methods: {
       orderLeaderboard() {
        if (!this.leaderboard || !Array.isArray(this.leaderboard)) {
            console.warn("orderLeaderboard called with invalid leaderboard:", this.leaderboard);
            return;
        }
        this.leaderboard.sort(function(x,y) {
            if (x.currentScore < y.currentScore) {
                return 1;
            }
            if (x.currentScore > y.currentScore) {
                return -1;
            }
            return 0;
        })
       },
       setLeaderboard(board) {
        console.log("setting leaderboard:");
        console.log(board);
        let newBoard = [];
        for(const element of board) {
            let score = 0;
            let name = "";
            if(element.hasOwnProperty("currentScore")) {
                score = element.currentScore;
            }
            else if(element.hasOwnProperty("score")) {
                score = element.score;
            }

            if(element.hasOwnProperty("name")) {
                name = element.name;
            }
            else if(element.hasOwnProperty("displayName")) {
                name = element.displayName;
            }

            newBoard.push({name: name, currentScore: score});
        }
        this.leaderboard = newBoard;
        this.orderLeaderboard();
       },
       error(message) {
        this.errorMessage = message;
        setTimeout(() => {this.errorMessage = "";}, 5000);
       },
       info(message) {
        this.infoMessage = message;
        setTimeout(() => {this.infoMessage = "";}, 5000);
       },
       login() {
        socket.emit('login', this.username,this.password);
        this.password = "";
        this.showPassword = false;
       },
       register() {
        if (this.password == this.confirmPassword) {
            socket.emit('register', this.username,this.password);
            this.password = "";
            this.confirmPassword = "";
            this.showPassword = false;
            this.showConfirmPassword = false;
        }
        else {
            this.error("Entered passwords aren't the same");
            this.password = "";
            this.confirmPassword = "";
            this.showPassword = false;
            this.showConfirmPassword = false;
        }
       },
       togglePassword() {
        this.showPassword = !this.showPassword;
       },
       toggleConfirmPassword() {
        this.showConfirmPassword = !this.showConfirmPassword;
       },
       startRegister() {
        this.registering = true;
       },
       stopRegister() {
        this.registering = false;
       },
       createLobby() {
        socket.emit('start', this.username)
       },
       joinLobby() {
        socket.emit('join', this.username, this.code)
       },
       toUpload() {
        socket.emit('toUpload');
       },
       backToMenu() {
        socket.emit('menu');
       },
       upload() {
        this.file = document.getElementById("image").files[0];
        let size = -1;
        let floatLat = parseFloat(this.lat);
        let floatLng = parseFloat(this.lng);
        let type = null;
        if (this.file != null) {
            switch(this.file.type) {
                case "image/png":
                    type = "png";
                    break;
                case "image/jpeg":
                    type = "jpeg";
                    break;
                case "image/jpg":
                    type = "jpg";
                    break;
            }
            size = this.file.size;
        }
        if (this.file == null) { this.error("No file uploaded"); return; }
        if (this.locName == "") { this.error("No name provided"); return; }
        if (isNaN(floatLat)) { this.error("Invalid latitude provided"); return; }
        if (isNaN(floatLng)) { this.error("Invalid longitude provided"); return; }
        if (type == null) { this.error("Invalid file type, please use png, jpg or jpeg"); return; }
        if (size > maxFileSize) { this.error("File too large, please keep image under 1MB"); return; }
        let reader = new FileReader();
        reader.addEventListener("load", () => {
            let data = {name: this.locName,lat: floatLat, lon: floatLng, fileType: type, imageBase64:reader.result}
            socket.emit('upload', data);
            document.getElementById("image").value = "";
            this.file = null;
            this.lat = "";
            this.lng = "";
            this.locName = "";
        })
        reader.readAsDataURL(this.file);
       },
       advance() {
        if (this.state.isAdmin) {
            socket.emit('advance');
        }
       },
       startMenu(state) {
        this.update(state);
       },
       startLobby(state, code) {
        this.update(state);
        this.leaderboard = this.state.otherPlayers;
        this.leaderboard.unshift(this.state.player);
        this.code = code;
       },
       startGuessing(state, location, time) {
        this.update(state);
        this.awnsered = false;
        this.location = location;
        this.setBuildingImage();
        // Wait for Vue to render the view that contains #map, then init it
        this.$nextTick(() => {
            if (document.getElementById("map")) {
                resetMap();
            }
        });
        stopTimer();
        startTimer(time);
       },
       startAwnsers(state, playerScores) {
        this.update(state);
        stopTimer();
        this.setLeaderboard(playerScores);
        console.log("player scores:");
        console.log(this.leaderboard);
        console.log(state);
        this.orderLeaderboard();
        this.setBuildingImage();
        // Wait for Vue to render the view that contains #map, then init it
        this.$nextTick(() => {
            if (document.getElementById("map")) {
                resetMap();
            }
        });
       },
       startScores(state) {
        this.update(state);
        stopTimer();

        // Normalise scores (some payloads use score/displayName instead of currentScore/name)
        const finalBoard = [...(this.state.otherPlayers || []), this.state.player].filter(Boolean);
        this.setLeaderboard(finalBoard);

        // Wait for Vue to render the Scores view (which contains #map), then init it
        this.$nextTick(() => {
            if (document.getElementById("map")) {
                resetMap();
            }
        });
       },
       nextRound() {
        if (this.state.isAdmin) {
            socket.emit('nextRound');
        }
       },
       startUpload(state) {
        this.update(state);
       },
       setBuildingImage() {
        let element = document.getElementById("guessImage");
        if (element != null) {
            console.log("setting image");
            console.log(this.location.blob.url);
            console.log(this.location);
            element.src = this.location.blob.url;
        }
        else {setTimeout(this.setBuildingImage, 1000);}
       },
       awnser() {
            if (this.awnsered) { return; }

                // If the player never clicked the map, send a "timeout guess" that scores 0
            if (this.state.player.guess == null) {
            this.state.player.guess = { lat: 0, lon: 0, timedOut: true };
            console.log("time out - submitting 0-score guess", this.state.player.guess);
            }
            this.awnsered = true;
            this.info("Guess submitted. Waiting for the round to end.");
            socket.emit("guess", this.state.player.guess);
        },
       update(state) {
        this.state = state;
        this.errorMessage = "";
        if (state.state.gameState === 0) {
            this.leaderboard = this.state.otherPlayers;
            this.leaderboard.unshift(this.state.player);
        }
       }
    }
});

function connect() {
    //Prepare web socket
    socket = io();

    //Connect
    socket.on('connect', function() {
        //Set connected state to true
        app.connected = true;
    });

    //Handle connection error
    socket.on('connect_error', function(message) {
        alert('Unable to connect: ' + message);
    });

    //handle setting leaderboard
    socket.on('leaderboard', function(board) {
        app.setLeaderboard(board);
    });

    socket.on('menu', function(state) {
        app.startMenu(state)
    });

    socket.on('lobby', function(state,code) {
        app.startLobby(state, code)
    });

    //handle starting guesses
    socket.on('guess', function(state,location,time) {
        app.startGuessing(state,location,time);
    });

    socket.on('awnsers', function(state, playerScores) {
        console.log("starting awnsers");
        console.log(playerScores);
        app.startAwnsers(state, playerScores);
    });

    socket.on('scores', function(state) {
        app.startScores(state)
    });

    socket.on('upload', function(state) {
        app.startUpload(state)
    });

    //handle state update
    socket.on('update', function(state) {
        app.update(state);
    });

    socket.on('fail', function(message) {
        app.error(message);
    });
    
    socket.on('notice', function(message) {
        app.info(message);
    });

    socket.on('roundEnd', function() {
        app.info("Time is up. Calculating scores...");
        stopTimer();
        app.timerText = "TIME'S UP!";
    });

    //Handle disconnection
    socket.on('disconnect', function() {
        app.disconnected = true;
        app.connected = false;
    });
};

//handle maps
function mapClicked(latLng) {
    if (!app.awnsered) {
        clearMarkers();
        map.panTo(latLng);
        console.log(latLng);
        app.state.player.guess = {lat:latLng.lat(), lon:latLng.lng()};
        app.mapMarkers.push(new google.maps.marker.AdvancedMarkerElement({
            map,
            position: latLng,
        }));
    }
};

function clearMarkers() {
  for (const m of app.mapMarkers) {
    if (m && "map" in m) {
      m.map = null;
    }
    else if (m && typeof m.setMap === "function") {
      m.setMap(null);
    }
  }
  app.mapMarkers = [];
}


function resetMap() {
    clearMarkers();
    initMap();
}

function initMap() {
    if (document.getElementById('map') != null) {
        let soton = {lat: 50.923406, lng: -1.401113}
        let center = soton;
        let zoom = 12;

        // Show the real location on Answers (2) and Scores (3)
        if (app.location != null && (app.state.state.gameState == 2 || app.state.state.gameState == 3)) {
            center = {lat: app.location.location.lat, lng: app.location.location.lon};
            zoom = 15;
        }

        map = new google.maps.Map(
            document.getElementById('map'), {
                zoom: zoom,
                center: center,
                mapId: "MAP_ID",
                streetViewControl: false,
                mapTypeControl: false,
            }
        );

        //add guess markers
        if (app.state.player.guess != null) {
            console.log("adding player guess marker")
            console.log({lat: app.state.player.guess.lat, lng: app.state.player.guess.lon})
            console.log(app.state.player.guess)
            new google.maps.marker.AdvancedMarkerElement({
                map,
                position: {lat: app.state.player.guess.lat, lng: app.state.player.guess.lon},
            });
        }
        
        for (const player of app.state.otherPlayers) {
            if (player.guess != null) {
                const otherPinStyle = new google.maps.marker.PinElement({
                    background: '#006ab0ff',
                    borderColor: '#004e82ff',
                    glyphColor: '#004e82ff'
                });
                let otherGuesses = new google.maps.marker.AdvancedMarkerElement({
                    map,
                    position: {lat: player.guess.lat, lng: player.guess.lon},
                });
                otherGuesses.append(otherPinStyle)
            }
        }

        if (app.location != null && (app.state.state.gameState == 2 || app.state.state.gameState == 3)) {
            const pinBackground = new google.maps.marker.PinElement({
                background: '#FBBC04',
                borderColor: '#a57c00ff',
                glyphColor: '#a57c00ff'
            });
            console.log("adding correct location marker")
            console.log(app.location)
            console.log({lat: app.location.location.lat, lng: app.location.location.lon})
            let correctLocation = new google.maps.marker.AdvancedMarkerElement({
                    map,
                    position: {lat: app.location.location.lat, lng: app.location.location.lon},
                });
            correctLocation.append(pinBackground);
        }

        if (app.state.state.gameState == 1) {
            map.addListener("click", (e) => {
                mapClicked(e.latLng);
            });
        }
        return
    }
    setTimeout(initMap, 1000);
};

//timer functions
function startTimer(time) {
    stopTimer();
    app.guessTime = time;
    timerId = setInterval(timeDecrement, 1000);
}

function stopTimer() {
    if (timerId != null) {
        clearInterval(timerId);
        timerId = null;
    }
}

function timeDecrement() {
    mins = Math.floor(app.guessTime / 60);
    sec = app.guessTime % 60;
    let text = mins + ":";
    if (sec < 10) {text = text + "0" + sec;}
    else {text = text + sec;}
    app.timerText = text;
    app.guessTime -= 1;
    if (app.guessTime == 0) {
        endTime();
    }
}

function endTime() {
    if (timerId != null) {
        clearInterval(timerId);
        timerId = null;
        app.timerText = "TIME'S UP!";
        app.awnser();
    }
}

function updateLeaderboard() {
    let element = document.getElementById('leaderboardTimeframe');
    if (element != null && element.value != "Default") {

        let scope = element.value;

        // Frontend-only: resolve "month:CURRENT" to "month:YYYY-MM" in UTC
        if (scope === "month:CURRENT") {
            const d = new Date();
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
            scope = `month:${yyyy}-${mm}`;
        }

        socket.emit('leaderboard', scope);
    }
}