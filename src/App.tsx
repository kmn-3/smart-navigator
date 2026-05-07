import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { MapPin, Navigation, RotateCcw, Info, ChevronRight, Clock, Map as MapIcon, Crosshair, ArrowUpDown, TrendingUp, Cpu, CheckCircle2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Fix for Leaflet default icon issues in React
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface RouteStep {
  instruction: string;
  distance: number;
  name: string;
  maneuver: {
    type: string;
    modifier?: string;
    location: [number, number];
  };
  alert?: {
    type: 'sharp-turn' | 'intersection' | 'slope' | 'info';
    message: string;
  };
}

interface RouteData {
  coordinates: [number, number][];
  distance: number;
  duration: number;
  steps: RouteStep[];
  calories: number;
  co2Saved: number;
  elevations: { distance: number; elevation: number }[];
}

const MapEvents = ({ onMapClick }: { onMapClick: (latlng: L.LatLng) => void }) => {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng);
    },
  });
  return null;
};

// Coordinate conversion for China (WGS-84 to GCJ-02)
const WGS84_TO_GCJ02 = {
  a: 6378245.0,
  ee: 0.00669342162296594323,
  transformLat: (x: number, y: number) => {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  },
  transformLng: (x: number, y: number) => {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  },
  outOfChina: (lat: number, lng: number) => {
    if (lng < 72.004 || lng > 137.8347) return true;
    if (lat < 0.8293 || lat > 55.8271) return true;
    return false;
  },
  convert: (lat: number, lng: number): [number, number] => {
    if (WGS84_TO_GCJ02.outOfChina(lat, lng)) return [lat, lng];
    let dLat = WGS84_TO_GCJ02.transformLat(lng - 105.0, lat - 35.0);
    let dLng = WGS84_TO_GCJ02.transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - WGS84_TO_GCJ02.ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((WGS84_TO_GCJ02.a * (1 - WGS84_TO_GCJ02.ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (WGS84_TO_GCJ02.a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lat + dLat, lng + dLng];
  },
  invert: (lat: number, lng: number): [number, number] => {
    if (WGS84_TO_GCJ02.outOfChina(lat, lng)) return [lat, lng];
    let dLat = WGS84_TO_GCJ02.transformLat(lng - 105.0, lat - 35.0);
    let dLng = WGS84_TO_GCJ02.transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - WGS84_TO_GCJ02.ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((WGS84_TO_GCJ02.a * (1 - WGS84_TO_GCJ02.ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (WGS84_TO_GCJ02.a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lat - dLat, lng - dLng];
  }
};

// Headless component to handle map location logic
const LocateTrigger = ({ trigger, onLocate }: { trigger: number; onLocate: (latlng: L.LatLng) => void }) => {
  const map = useMap();
  
  useEffect(() => {
    if (trigger > 0) {
      map.locate({ setView: true, maxZoom: 16 });
    }
  }, [trigger, map]);

  useMapEvents({
    locationfound(e) {
      onLocate(e.latlng);
      map.flyTo(e.latlng, 16);
    },
    locationerror() {
      alert("无法获取您的位置，请检查浏览器权限设置。");
    }
  });

  return null;
};

const FitBounds = ({ points }: { points: [number, number][] }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length >= 2) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [points, map]);
  return null;
};


export default function App() {
  const [startPoint, setStartPoint] = useState<L.LatLng | null>(null);
  const [endPoint, setEndPoint] = useState<L.LatLng | null>(null);
  const [userLocation, setUserLocation] = useState<L.LatLng | null>(null);
  const [locateTrigger, setLocateTrigger] = useState(0);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile] = useState<'bicycle'>('bicycle');
  const [lastSyncedData, setLastSyncedData] = useState<any>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isCalculated, setIsCalculated] = useState(false);

  // Initial location attempt
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          setUserLocation(new L.LatLng(latitude, longitude));
        },
        (error) => {
          console.log("Initial location failed:", error.message);
        }
      );
    }
  }, []);

  const handleMapClick = (latlng: L.LatLng) => {
    // Convert click (GCJ-02) back to WGS-84 for OSRM
    const [wgsLat, wgsLng] = WGS84_TO_GCJ02.invert(latlng.lat, latlng.lng);
    const wgsCoords = new L.LatLng(wgsLat, wgsLng);
    
    if (!startPoint) {
      setStartPoint(wgsCoords);
    } else if (!endPoint) {
      setEndPoint(wgsCoords);
    }
  };

  const reset = () => {
    setStartPoint(null);
    setEndPoint(null);
    setRoute(null);
    setError(null);
    setIsCalculated(false);
  };

  const swapPoints = () => {
    const temp = startPoint;
    setStartPoint(endPoint);
    setEndPoint(temp);
  };

  const [syncing, setSyncing] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);

  const getDirection = (bearing: number) => {
    const directions = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
  };

  const analyzeStep = (step: any): RouteStep['alert'] | undefined => {
    const instruction = (step.maneuver?.instruction || '').toLowerCase();
    const modifier = step.maneuver?.modifier;

    if (modifier?.includes('sharp')) {
      return { type: 'sharp-turn', message: '前方急转弯，请减速' };
    }
    if (instruction.includes('intersection') || instruction.includes('cross')) {
      return { type: 'intersection', message: '经过十字路口，注意侧方来车' };
    }
    if (step.distance > 500 && instruction && !instruction.includes('continue')) {
      return { type: 'info', message: '长距离直行' };
    }
    return undefined;
  };

  const getHaversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3; // meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const syncToDevice = async () => {
    if (!route) return;
    setSyncing(true);
    try {
      // 精简数据给 ESP32，使用短键和英文指令
      const deviceData = {
        dst: Math.round(route.distance),
        dur: Math.round(route.duration),
        pts: route.coordinates.filter((_, i) => i % 5 === 0).map(c => [
          parseFloat(c[0].toFixed(5)), 
          parseFloat(c[1].toFixed(5))
        ]), 
        steps: route.steps.map(s => {
          let inst = s.instruction;
          // 将中文指令映射为简短的英文指令
          if (inst.includes('左转')) inst = 'L';
          else if (inst.includes('右转')) inst = 'R';
          else if (inst.includes('直行') || inst.includes('前行')) inst = 'S';
          else if (inst.includes('调头')) inst = 'U';
          else if (inst.includes('起点')) inst = 'Start';
          else if (inst.includes('终点')) inst = 'End';
          else inst = 'Go';

          return {
            i: inst,
            d: Math.round(s.distance),
            l: s.maneuver.location.map(n => parseFloat(n.toFixed(5)))
          };
        })
      };

      const res = await fetch('/api/sync-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData)
      });

      if (res.ok) {
        setSyncSuccess(true);
        setLastSyncedData(deviceData);
        setTimeout(() => setSyncSuccess(false), 3000);
      }
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  const fetchRoute = useCallback(async () => {
    if (!startPoint || !endPoint) return;

    setLoading(true);
    setError(null);
    setIsCalculated(true);
    try {
      const osrmProfile = profile;
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/${osrmProfile}/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson&steps=true`
      );
      const data = await response.json();

      if (data.code !== 'Ok') {
        if (data.code === 'NoRoute') {
          throw new Error(`无法在当前模式(${profile === 'bicycle' ? '骑行' : profile === 'car' ? '驾车' : '步行'})下找到路径。可能是因为起点或终点不在路网覆盖范围内，或者该区域缺少此类路径数据。`);
        }
        throw new Error(`路由服务返回错误: ${data.code}`);
      }

      const routeResult = data.routes[0];
      const coordinates = routeResult.geometry.coordinates.map((coord: [number, number]) => [coord[1], coord[0]]);
      
      let steps = routeResult.legs[0].steps.map((step: any) => {
        const bearing = step.maneuver?.bearing_after || 0;
        const direction = getDirection(bearing);
        let instruction = step.maneuver?.instruction || `继续向${direction}方向前行`;
        
        if (instruction === 'Continue' || instruction === '继续前行') {
          instruction = `继续向${direction}方向前行`;
        }

        return {
          instruction,
          distance: step.distance,
          name: step.name || '道路',
          maneuver: step.maneuver,
          alert: analyzeStep(step)
        };
      });

      // Real Slope Detection using full geometry for higher accuracy
      try {
        const fullCoords = routeResult.geometry.coordinates.map((c: any) => ({ lat: c[1], lng: c[0] }));
        const chunkSize = 50; 
        let fullElevations: number[] = [];
        
        // Fetch elevations for ALL points in the geometry
        for (let i = 0; i < fullCoords.length; i += chunkSize) {
          const chunk = fullCoords.slice(i, i + chunkSize);
          const lats = chunk.map((c: any) => c.lat).join(',');
          const lngs = chunk.map((c: any) => c.lng).join(',');
          
          let chunkSuccess = false;
          let retries = 2;

          while (retries > 0 && !chunkSuccess) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000);
              const endpoint = retries === 1 ? `https://api.open-meteo.com/v1/elevation` : `https://elevation-api.open-meteo.com/v1/elevation`;
              const elevRes = await fetch(`${endpoint}?latitude=${lats}&longitude=${lngs}`, { signal: controller.signal });
              clearTimeout(timeoutId);

              if (elevRes.ok) {
                const elevData = await elevRes.json();
                fullElevations = [...fullElevations, ...elevData.elevation];
                chunkSuccess = true;
              } else {
                throw new Error(`Status: ${elevRes.status}`);
              }
            } catch (chunkError) {
              retries--;
              if (retries === 0) {
                const lastElev = fullElevations.length > 0 ? fullElevations[fullElevations.length - 1] : 0;
                const fillSize = Math.min(chunkSize, fullCoords.length - fullElevations.length);
                fullElevations = [...fullElevations, ...new Array(fillSize).fill(lastElev)];
              } else {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
          }
        }

        // Analyze segments for elevation profile and max grade
        let maxGrade = 0;
        const elevationProfile: { distance: number; elevation: number }[] = [];
        let accumulatedDist = 0;

        if (fullElevations.length === fullCoords.length) {
          // 1. 中值滤波：去除海拔突变噪点
          const medianFiltered = [...fullElevations];
          for (let i = 1; i < fullElevations.length - 1; i++) {
            const window = [fullElevations[i-1], fullElevations[i], fullElevations[i+1]].sort((a, b) => a - b);
            medianFiltered[i] = window[1];
          }

          // 2. 桥梁检测与线性插值
          const processedElevations = [...medianFiltered];
          for (let i = 1; i < processedElevations.length - 5; i++) {
            const prev = processedElevations[i-1];
            if (prev - processedElevations[i] > 2.5) {
              let recoveryIdx = -1;
              for (let k = i + 1; k < Math.min(i + 20, processedElevations.length); k++) {
                if (processedElevations[k] >= prev - 0.5) {
                  recoveryIdx = k;
                  break;
                }
              }
              if (recoveryIdx !== -1) {
                const startElev = processedElevations[i-1];
                const endElev = processedElevations[recoveryIdx];
                for (let m = i; m < recoveryIdx; m++) {
                  const t = (m - (i - 1)) / (recoveryIdx - (i - 1));
                  processedElevations[m] = startElev + (endElev - startElev) * t;
                }
                i = recoveryIdx;
              }
            }
          }

          // 3. 高斯平滑
          const finalElevations = [...processedElevations];
          const sigma = 2;
          for (let i = sigma; i < processedElevations.length - sigma; i++) {
            let weightSum = 0;
            let valSum = 0;
            for (let j = -sigma; j <= sigma; j++) {
              const weight = Math.exp(-(j * j) / (2 * sigma * sigma));
              valSum += processedElevations[i + j] * weight;
              weightSum += weight;
            }
            finalElevations[i] = valSum / weightSum;
          }

          finalElevations.forEach((elev, i) => {
            if (i > 0) {
              accumulatedDist += getHaversineDistance(
                fullCoords[i-1].lat, fullCoords[i-1].lng,
                fullCoords[i].lat, fullCoords[i].lng
              );
            }
            elevationProfile.push({ distance: Math.round(accumulatedDist), elevation: elev });
          });

          // Calculate max grade for statistics only (no alerts)
          for (let j = 0; j < finalElevations.length - 5; j++) {
            const nextJ = j + 5;
            const rise = finalElevations[nextJ] - finalElevations[j];
            const dist = getHaversineDistance(fullCoords[j].lat, fullCoords[j].lng, fullCoords[nextJ].lat, fullCoords[nextJ].lng);
            if (dist > 30) {
              const grade = Math.min(Math.max((rise / dist) * 100, -25), 25);
              if (Math.abs(grade) > Math.abs(maxGrade)) maxGrade = grade;
            }
          }
        }

        const calories = Math.round((routeResult.distance / 1000) * (profile === 'bicycle' ? 30 : profile === 'foot' ? 50 : 0));
        const co2Saved = parseFloat(((routeResult.distance / 1000) * 0.12).toFixed(2));

        setRoute({
          coordinates,
          distance: routeResult.distance,
          duration: routeResult.duration,
          steps,
          calories,
          co2Saved,
          elevations: elevationProfile
        });
      } catch (e) {
        console.error("Elevation fetch failed:", e);
      }
    } catch (err: any) {
      setError(err.message || '获取路径失败，请重试');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [startPoint, endPoint, profile]);

  // Manual route calculation triggered by button

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${Math.round(meters)}米`;
    return `${(meters / 1000).toFixed(1)}公里`;
  };

  const formatDuration = (seconds: number) => {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}小时${remainingMinutes}分` : `${hours}小时`;
  };

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'sharp-turn': return <RotateCcw className="w-4 h-4 text-orange-500" />;
      case 'intersection': return <MapPin className="w-4 h-4 text-blue-500" />;
      case 'slope': return <Navigation className="w-4 h-4 text-red-500 rotate-45" />;
      default: return <Info className="w-4 h-4 text-stone-400" />;
    }
  };

  return (
    <div className="relative h-screen w-full bg-stone-100 font-sans overflow-hidden flex flex-col md:flex-row">
      {/* Sidebar Toggle Button (Mobile) */}
      <button 
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed bottom-6 right-6 z-[2000] md:hidden w-12 h-12 bg-stone-900 text-white rounded-full shadow-2xl flex items-center justify-center transition-all active:scale-90"
      >
        {sidebarOpen ? <ChevronRight className="w-6 h-6 rotate-90" /> : <Navigation className="w-6 h-6" />}
      </button>

      {/* Sidebar */}
      <div className={cn(
        "bg-white border-stone-200 flex flex-col z-20 shadow-xl transition-all duration-300 ease-in-out shrink-0",
        sidebarOpen 
          ? "w-full md:w-72 h-1/2 md:h-full opacity-100 translate-y-0 md:translate-x-0" 
          : "w-full md:w-0 h-0 md:h-full opacity-0 translate-y-full md:-translate-x-full"
      )}>
        <div className="p-4 border-b border-stone-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Navigation className="w-5 h-5 text-emerald-600" />
            <h1 className="text-lg font-bold text-stone-900 tracking-tight">多功能骑行头盔</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setLocateTrigger(prev => prev + 1)}
              className="p-1.5 bg-stone-50 hover:bg-stone-100 text-stone-500 rounded-md transition-all active:scale-95 border border-stone-100"
              title="定位"
            >
              <Crosshair className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 bg-stone-50 hover:bg-red-50 text-stone-400 hover:text-red-500 rounded-md transition-all active:scale-95 border border-stone-100 md:hidden"
            >
              <ChevronRight className="w-3.5 h-3.5 rotate-90" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Status Cards - More Compact */}
          <div className="space-y-2 relative">
            <div className={cn(
              "p-3 rounded-lg border transition-all",
              startPoint ? "bg-emerald-50 border-emerald-100" : "bg-stone-50 border-stone-100"
            )}>
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold",
                  startPoint ? "bg-emerald-500" : "bg-stone-300"
                )}>起</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-stone-600 truncate">
                    {startPoint ? `${startPoint.lat.toFixed(5)}, ${startPoint.lng.toFixed(5)}` : "选择起点"}
                  </p>
                </div>
              </div>
            </div>

            <button 
              onClick={swapPoints}
              className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-1 bg-white border border-stone-200 rounded-md shadow-sm hover:bg-emerald-50 transition-all"
              title="切换"
            >
              <ArrowUpDown className="w-3 h-3 text-emerald-600" />
            </button>

            <div className={cn(
              "p-3 rounded-lg border transition-all",
              endPoint ? "bg-blue-50 border-blue-100" : "bg-stone-50 border-stone-100"
            )}>
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold",
                  endPoint ? "bg-blue-500" : "bg-stone-300"
                )}>终</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-stone-600 truncate">
                    {endPoint ? `${endPoint.lat.toFixed(5)}, ${endPoint.lng.toFixed(5)}` : "选择终点"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {!isCalculated && startPoint && endPoint && (
            <button
              onClick={fetchRoute}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold transition-all shadow-md active:scale-95"
            >
              {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Navigation className="w-4 h-4" />}
              开始计算路径
            </button>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center py-6 text-stone-400">
              <div className="w-6 h-6 border-3 border-stone-100 border-t-emerald-500 rounded-full animate-spin mb-2" />
              <p className="text-[10px]">规划中...</p>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm flex items-start gap-2">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {lastSyncedData && (
            <div className="p-4 bg-stone-900 rounded-xl border border-stone-800 shadow-inner animate-in fade-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-emerald-500" />
                  <h3 className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">已发送至 ESP32</h3>
                </div>
                <button 
                  onClick={() => setLastSyncedData(null)}
                  className="text-stone-500 hover:text-white text-[10px] transition-colors"
                >清除</button>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-[10px]">
                  <span className="text-stone-400">轨迹点数</span>
                  <span className="text-white font-mono">{lastSyncedData.pts.length}</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-stone-400">导航步骤</span>
                  <span className="text-white font-mono">{lastSyncedData.steps.length}</span>
                </div>
                <div className="mt-3">
                  <p className="text-[9px] text-stone-500 mb-1 uppercase font-bold">数据预览 (JSON)</p>
                  <div className="relative group">
                    <pre className="text-[9px] text-emerald-400/80 bg-black/50 p-2 rounded-lg overflow-x-auto font-mono max-h-32 scrollbar-thin scrollbar-thumb-stone-700">
                      {JSON.stringify(lastSyncedData, null, 2)}
                    </pre>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent pointer-events-none rounded-lg" />
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3 p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                  <Info className="w-3 h-3 text-emerald-500" />
                  <p className="text-[9px] text-emerald-500/80 leading-tight">
                    ESP32 可通过 GET 请求获取此 JSON 数据
                  </p>
                </div>
              </div>
            </div>
          )}

          {route && !loading && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 bg-stone-50 rounded-lg border border-stone-100">
                  <div className="flex items-center gap-1.5 text-stone-400 mb-0.5">
                    <MapIcon className="w-3 h-3" />
                    <span className="text-[9px] font-bold uppercase tracking-widest">距离</span>
                  </div>
                  <p className="text-sm font-bold text-stone-800">{formatDistance(route.distance)}</p>
                </div>
                <div className="p-2 bg-stone-50 rounded-lg border border-stone-100">
                  <div className="flex items-center gap-1.5 text-stone-400 mb-0.5">
                    <Clock className="w-3 h-3" />
                    <span className="text-[9px] font-bold uppercase tracking-widest">时间</span>
                  </div>
                  <p className="text-sm font-bold text-stone-800">{formatDuration(route.duration)}</p>
                </div>
                <div className="p-2 bg-blue-50/50 rounded-lg border border-blue-100/50">
                  <div className="flex items-center gap-1.5 text-blue-600/60 mb-0.5">
                    <div className="w-1 h-1 rounded-full bg-blue-500" />
                    <span className="text-[9px] font-bold uppercase tracking-widest">CO₂</span>
                  </div>
                  <p className="text-sm font-bold text-blue-700">{route.co2Saved} kg</p>
                </div>
                <div className="p-2 bg-emerald-50/50 rounded-lg border border-emerald-100/50">
                  <div className="flex items-center gap-1.5 text-emerald-600/60 mb-0.5">
                    <div className="w-1 h-1 rounded-full bg-emerald-500" />
                    <span className="text-[9px] font-bold uppercase tracking-widest">热量</span>
                  </div>
                  <p className="text-sm font-bold text-emerald-700">{route.calories} kcal</p>
                </div>
              </div>

              {/* Elevation Chart */}
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-100">
                <h3 className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-4">海拔剖面 (米)</h3>
                <div className="h-32 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={route.elevations}>
                      <defs>
                        <linearGradient id="colorElev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis 
                        dataKey="distance" 
                        hide 
                      />
                      <YAxis 
                        hide 
                        domain={['dataMin - 5', 'dataMax + 5']} 
                      />
                      <Tooltip 
                        labelFormatter={(value) => `距离: ${value}m`}
                        formatter={(value: any) => [`${value}m`, '海拔']}
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontSize: '10px' }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="elevation" 
                        stroke="#10b981" 
                        fillOpacity={1} 
                        fill="url(#colorElev)" 
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest px-1">导航步骤</h3>
                <div className="space-y-1">
                  {route.steps.map((step, idx) => (
                    <div key={idx} className="group flex flex-col p-3 hover:bg-stone-50 rounded-lg transition-colors border border-transparent hover:border-stone-100">
                      <div className="flex items-start gap-3">
                        <div className="mt-1 flex-shrink-0">
                          <ChevronRight className="w-4 h-4 text-emerald-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-stone-700 leading-snug font-medium">{step.instruction}</p>
                          <p className="text-[10px] text-stone-400 mt-1">{formatDistance(step.distance)}</p>
                        </div>
                      </div>
                      {step.alert && (
                        <div className={cn(
                          "mt-2 p-2 rounded flex items-center gap-2 text-[10px] font-bold border",
                          step.alert.type === 'sharp-turn' ? "bg-orange-50 border-orange-100 text-orange-600" :
                          step.alert.type === 'slope' ? "bg-red-50 border-red-100 text-red-600" :
                          "bg-blue-50 border-blue-100 text-blue-600"
                        )}>
                          {getAlertIcon(step.alert.type)}
                          <span>{step.alert.message}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-stone-100 bg-stone-50/50 space-y-2">
          {route && (
            <button
              onClick={syncToDevice}
              disabled={syncing}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-bold transition-all shadow-md active:scale-[0.98]",
                syncSuccess 
                  ? "bg-emerald-500 text-white" 
                  : "bg-stone-900 hover:bg-stone-800 text-white"
              )}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span className="text-xs">{syncSuccess ? "已同步到云端" : "同步到 ESP32"}</span>
            </button>
          )}
          <button
            onClick={reset}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-white border border-stone-200 hover:bg-stone-50 text-stone-600 rounded-lg font-bold text-xs transition-all active:scale-[0.98]"
          >
            <RotateCcw className="w-3 h-3" />
            重置
          </button>
        </div>
      </div>

      {/* Desktop Sidebar Pull-out Handle */}
      {!sidebarOpen && (
        <button 
          onClick={() => setSidebarOpen(true)}
          className="fixed left-0 top-1/2 -translate-y-1/2 z-30 bg-white border border-l-0 border-stone-200 p-2 rounded-r-xl shadow-lg text-stone-400 hover:text-emerald-500 transition-all hidden md:block"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* Map Container */}
      <div className="flex-1 relative z-10">
        <MapContainer
          center={[39.9042, 116.4074]}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="http://www.amap.com/">Amap</a>'
            url="http://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
            subdomains="1234"
          />
          
          <MapEvents onMapClick={handleMapClick} />
          <LocateTrigger trigger={locateTrigger} onLocate={setUserLocation} />
          
          {userLocation && (
            <Marker 
              position={WGS84_TO_GCJ02.convert(userLocation.lat, userLocation.lng)}
              icon={L.divIcon({
                className: 'bg-transparent',
                html: `<div class="relative">
                        <div class="absolute -inset-2 bg-blue-500/30 rounded-full animate-ping"></div>
                        <div class="relative w-4 h-4 bg-blue-600 border-2 border-white rounded-full shadow-lg"></div>
                      </div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
              })}
            >
              <Popup>您的当前位置</Popup>
            </Marker>
          )}

          {startPoint && (
            <Marker position={WGS84_TO_GCJ02.convert(startPoint.lat, startPoint.lng)}>
              <Popup>起点</Popup>
            </Marker>
          )}
          
          {endPoint && (
            <Marker position={WGS84_TO_GCJ02.convert(endPoint.lat, endPoint.lng)}>
              <Popup>终点</Popup>
            </Marker>
          )}

          {route && (
            <>
              {/* 路线主体 */}
              <Polyline 
                positions={route.coordinates.map(coord => WGS84_TO_GCJ02.convert(coord[0], coord[1]))} 
                color="#10b981" 
                weight={6} 
                opacity={0.8}
                lineJoin="round"
                className="route-line-animated"
              />

              <FitBounds points={route.coordinates.map(coord => WGS84_TO_GCJ02.convert(coord[0], coord[1]))} />
            </>
          )}
        </MapContainer>

        {/* Floating Map Controls - Removed toast as requested */}
        <div className="absolute top-6 right-6 flex flex-col gap-2 z-[1000]">
          {/* Toast removed */}
        </div>
      </div>
    </div>
  );
}
