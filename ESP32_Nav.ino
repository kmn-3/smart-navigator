#include <Arduino.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Wire.h>
#include <TinyGPS++.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "LittleFS.h"

// --- WiFi 配置 ---
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* serverUrl = "https://ais-dev-pnxkcp7ed4erxf5c7u3ebu-161751337975.asia-northeast1.run.app/api/device-route";

// --- OLED 配置 ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define I2C_SDA 47
#define I2C_SCL 21
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// --- GPS 配置 ---
#define GPS_TX_PIN 4
#define GPS_RX_PIN 5
TinyGPSPlus gps;
HardwareSerial SerialGPS(1);

// --- 导航数据存储 ---
struct NavStep {
    String instruction;
    float distance;
    float lat;
    float lon;
};

NavStep currentSteps[10]; // 简单起见，只存前10步
int stepCount = 0;
int currentStepIdx = 0;
bool hasRoute = false;

void connectWiFi() {
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("Connecting WiFi...");
    display.display();
    
    WiFi.begin(ssid, password);
    int counter = 0;
    while (WiFi.status() != WL_CONNECTED && counter < 20) {
        delay(500);
        Serial.print(".");
        counter++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        display.println("WiFi Connected!");
    } else {
        display.println("WiFi Failed!");
    }
    display.display();
    delay(1000);
}

void fetchRoute() {
    if (WiFi.status() != WL_CONNECTED) return;
    
    HTTPClient http;
    http.begin(serverUrl);
    int httpCode = http.GET();
    
    if (httpCode == 200) {
        String payload = http.getString();
        DynamicJsonDocument doc(16384);
        DeserializationError error = deserializeJson(doc, payload);
        
        if (!error) {
            JsonArray steps = doc["steps"];
            stepCount = min((int)steps.size(), 10);
            for (int i = 0; i < stepCount; i++) {
                currentSteps[i].instruction = steps[i]["instruction"].as<String>();
                currentSteps[i].distance = steps[i]["dist"].as<float>();
                currentSteps[i].lon = steps[i]["loc"][0].as<float>();
                currentSteps[i].lat = steps[i]["loc"][1].as<float>();
            }
            hasRoute = true;
            currentStepIdx = 0;
            Serial.println("Route fetched successfully!");
        }
    }
    http.end();
}

void setup() {
    Serial.begin(115200);
    delay(2000);
    
    // 初始化 OLED
    Wire.begin(I2C_SDA, I2C_SCL);
    if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
        for(;;);
    }
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    
    // 初始化 GPS
    SerialGPS.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    
    // 连接网络并同步
    connectWiFi();
    fetchRoute();
}

void displayNav() {
    display.clearDisplay();
    display.setCursor(0, 0);
    
    if (!hasRoute) {
        display.println("No Route Synced");
        display.println("Please sync from Web");
    } else {
        // 显示当前导航指令
        display.setTextSize(1);
        display.println("Navigation:");
        display.drawLine(0, 10, 128, 10, WHITE);
        
        display.setCursor(0, 15);
        display.setTextSize(1);
        display.println(currentSteps[currentStepIdx].instruction);
        
        display.setCursor(0, 45);
        display.print("Next in: ");
        display.print(currentSteps[currentStepIdx].distance, 0);
        display.println(" m");
        
        // 如果有 GPS，显示当前速度
        if (gps.location.isValid()) {
            display.setCursor(0, 55);
            display.print("SPD: ");
            display.print(gps.speed.kmph(), 1);
            display.print(" km/h  Sats:");
            display.print(gps.satellites.value());
        }
    }
    
    display.display();
}

void loop() {
    while (SerialGPS.available() > 0) {
        gps.encode(SerialGPS.read());
    }

    // 简单的导航逻辑：如果距离目标点小于 20 米，切换到下一步
    if (hasRoute && gps.location.isValid()) {
        float distToTarget = (float)TinyGPSPlus::distanceBetween(
            gps.location.lat(), gps.location.lng(),
            currentSteps[currentStepIdx].lat, currentSteps[currentStepIdx].lon
        );
        
        if (distToTarget < 20 && currentStepIdx < stepCount - 1) {
            currentStepIdx++;
        }
    }

    // 每秒刷新一次屏幕
    static unsigned long lastUpdate = 0;
    if (millis() - lastUpdate > 1000) {
        lastUpdate = millis();
        displayNav();
    }
    
    // 按键或定时重新同步 (此处省略，可根据需要添加)
}
