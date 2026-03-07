
/*
  Okey Free-Play ESP8266 Server
  Libraries required:
  - WebSockets by Markus Sattler
  - ArduinoJson by Benoit Blanchon
*/

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <LittleFS.h>

// WiFi Credentials (AP Mode)
const char* ssid = "Okey-Game-Table";
const char* password = "okeypassword";

ESP8266WebServer server(80);
WebSocketsServer webSocket = WebSocketsServer(81);

// Game State Constants
const int MAX_PLAYERS = 4;
const int TOTAL_TILES = 106;

struct Tile {
  String id;
  String color;
  int value;
  bool isFakeJoker;
};

struct Player {
  uint8_t num; // Socket ID
  String name;
  bool active = false;
  bool isHost = false;
};

Player players[MAX_PLAYERS];
int playerCount = 0;

// Simple Game Logic (Simplified for ESP8266 RAM constraints)
String getGameStateJSON() {
  StaticJsonDocument<2048> doc;
  doc["status"] = "playing"; // Simplified for demo
  JsonArray playersArr = doc.createNestedArray("players");
  
  for(int i=0; i<MAX_PLAYERS; i++) {
    if(players[i].active) {
      JsonObject p = playersArr.createNestedObject();
      p["id"] = String(players[i].num);
      p["name"] = players[i].name;
      p["isHost"] = players[i].isHost;
    }
  }
  
  String output;
  serializeJson(doc, output);
  return output;
}

void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      for(int i=0; i<MAX_PLAYERS; i++) {
        if(players[i].num == num) {
          players[i].active = false;
          playerCount--;
          break;
        }
      }
      webSocket.broadcastTXT(getGameStateJSON());
      break;
      
    case WStype_CONNECTED:
      {
        IPAddress ip = webSocket.remoteIP(num);
        Serial.printf("[%u] Connected from %d.%d.%d.%d\n", num, ip[0], ip[1], ip[2], ip[3]);
      }
      break;
      
    case WStype_TEXT:
      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, payload);
      if (error) return;

      String type = doc["type"];
      if(type == "join") {
        if(playerCount < MAX_PLAYERS) {
          for(int i=0; i<MAX_PLAYERS; i++) {
            if(!players[i].active) {
              players[i].num = num;
              players[i].name = doc["name"].as<String>();
              players[i].active = true;
              players[i].isHost = (playerCount == 0);
              playerCount++;
              break;
            }
          }
          webSocket.broadcastTXT(getGameStateJSON());
        }
      }
      break;
  }
}

void setup() {
  Serial.begin(115200);
  
  // 1. Set up WiFi Access Point
  WiFi.softAP(ssid, password);
  Serial.println("Access Point Started");
  Serial.print("IP Address: ");
  Serial.println(WiFi.softAPIP());

  // 2. Initialize File System (LittleFS)
  if(!LittleFS.begin()){
    Serial.println("An Error has occurred while mounting LittleFS");
    return;
  }

  // 3. Serve Static Files
  server.onNotFound([]() {
    if (!handleFileRead(server.uri())) {
      server.send(404, "text/plain", "FileNotFound");
    }
  });

  server.begin();
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);
  
  Serial.println("HTTP and WebSocket servers started");
}

bool handleFileRead(String path) {
  if (path.endsWith("/")) path += "index.html";
  String contentType = getContentType(path);
  if (LittleFS.exists(path)) {
    File file = LittleFS.open(path, "r");
    server.streamFile(file, contentType);
    file.close();
    return true;
  }
  return false;
}

String getContentType(String filename) {
  if (filename.endsWith(".html")) return "text/html";
  if (filename.endsWith(".css")) return "text/css";
  if (filename.endsWith(".js")) return "application/javascript";
  if (filename.endsWith(".ico")) return "image/x-icon";
  return "text/plain";
}

void loop() {
  webSocket.loop();
  server.handleClient();
}
