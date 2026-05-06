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
  maxGrade: number;
}

const MapEvents = ({ onMapClick }: { onMapClick: (latlng: L.LatLng) => void }) => {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng);
    },
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

const LocateControl = ({ onLocate }: { onLocate: (latlng: L.LatLng) => void }) => {
  const map = useMap();
  
  const handleLocate = useCallback(() => {
    map.locate({ setView: true, maxZoom: 16 });
  }, [map]);

  useMapEvents({
    locationfound(e) {
      onLocate(e.latlng);
      map.flyTo(e.latlng, 16);
    },
    locationerror(e) {
      alert("无法获取您的位置，请检查浏览器权限设置。");
    }
  });

  return (
    <div className="absolute top-4 right-4 z-[1000]">
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleLocate();
        }}
        className="bg-white p-3 rounded-full shadow-xl hover:bg-stone-50 transition-all active:scale-95 flex items-center justify-center border border-stone-100"
        title="定位我的位置"
      >
        <Crosshair className="w-6 h-6 text-emerald-600" />
      </button>
    </div>
  );
};

export default function App() {
  const [startPoint, setStartPoint] = useState<L.LatLng | null>(null);
  const [endPoint, setEndPoint] = useState<L.LatLng | null>(null);
  const [userLocation, setUserLocation] = useState<L.LatLng | null>(null);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<'bicycle' | 'foot'>('bicycle');
  const [lastSyncedData, setLastSyncedData] = useState<any>(null);

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
    if (!startPoint) {
      setStartPoint(latlng);
    } else if (!endPoint) {
      setEndPoint(latlng);
    }
  };

  const reset = () => {
    setStartPoint(null);
    setEndPoint(null);
    setRoute(null);
    setError(null);
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
      // 精简数据给 ESP32
      const deviceData = {
        distance: route.distance,
        duration: route.duration,
        maxGrade: route.maxGrade,
        // 关键点：每隔 5 个点取一个，或者只取转弯点，减少 ESP32 内存压力
        points: route.coordinates.filter((_, i) => i % 3 === 0), 
        steps: route.steps.map(s => ({
          instruction: s.instruction,
          dist: s.distance,
          loc: s.maneuver.location,
          alert: s.alert
        }))
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
    try {
      // OSRM profiles: bicycle, car, foot
      const osrmProfile = profile === 'car' ? 'driving' : profile;
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
          elevations: elevationProfile,
          maxGrade
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

  useEffect(() => {
    if (startPoint && endPoint) {
      fetchRoute();
    }
  }, [startPoint, endPoint, fetchRoute, profile]);

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
    <div className="relative h-screen w-full bg-stone-100 font-sans overflow-hidden flex">
      {/* Sidebar */}
      <div className="w-80 h-full bg-white border-r border-stone-200 flex flex-col z-20 shadow-xl">
        <div className="p-6 border-b border-stone-100">
          <div className="flex items-center gap-2 mb-2">
            <Navigation className="w-6 h-6 text-emerald-600" />
            <h1 className="text-xl font-bold text-stone-900 tracking-tight">智能骑行导航</h1>
          </div>
          <p className="text-sm text-stone-500">点击地图选择起点和终点</p>
        </div>

        <div className="px-4 py-3 border-b border-stone-100 bg-stone-50/30">
          <div className="flex p-1 bg-stone-100 rounded-lg">
            {(['bicycle', 'foot'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProfile(p)}
                className={cn(
                  "flex-1 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all",
                  profile === p 
                    ? "bg-white text-emerald-600 shadow-sm" 
                    : "text-stone-400 hover:text-stone-600"
                )}
              >
                {p === 'bicycle' ? '骑行' : '步行'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Status Cards */}
          <div className="space-y-3 relative">
            <div className={cn(
              "p-4 rounded-xl border transition-all",
              startPoint ? "bg-emerald-50 border-emerald-200" : "bg-stone-50 border-stone-200"
            )}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-white font-bold",
                  startPoint ? "bg-emerald-500" : "bg-stone-300"
                )}>A</div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-stone-400">起点</p>
                  <p className="text-sm font-medium text-stone-700 truncate">
                    {startPoint ? `${startPoint.lat.toFixed(4)}, ${startPoint.lng.toFixed(4)}` : "等待选择..."}
                  </p>
                </div>
              </div>
            </div>

            <button 
              onClick={swapPoints}
              className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 z-10 p-2 bg-white border border-stone-200 rounded-full shadow-md hover:bg-emerald-50 hover:border-emerald-200 transition-all active:scale-90"
              title="切换起点终点"
            >
              <ArrowUpDown className="w-4 h-4 text-emerald-600" />
            </button>

            <div className={cn(
              "p-4 rounded-xl border transition-all",
              endPoint ? "bg-blue-50 border-blue-200" : "bg-stone-50 border-stone-200"
            )}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-white font-bold",
                  endPoint ? "bg-blue-500" : "bg-stone-300"
                )}>B</div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-stone-400">终点</p>
                  <p className="text-sm font-medium text-stone-700 truncate">
                    {endPoint ? `${endPoint.lat.toFixed(4)}, ${endPoint.lng.toFixed(4)}` : "等待选择..."}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-stone-400">
              <div className="w-8 h-8 border-4 border-stone-200 border-t-emerald-500 rounded-full animate-spin mb-4" />
              <p className="text-sm">正在规划最优路径...</p>
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
                  <span className="text-white font-mono">{lastSyncedData.points.length}</span>
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
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
                  <div className="flex items-center gap-2 text-stone-400 mb-1">
                    <MapIcon className="w-3.5 h-3.5" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">距离</span>
                  </div>
                  <p className="text-lg font-bold text-stone-800">{formatDistance(route.distance)}</p>
                </div>
                <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
                  <div className="flex items-center gap-2 text-stone-400 mb-1">
                    <Clock className="w-3.5 h-3.5" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">预计用时</span>
                  </div>
                  <p className="text-lg font-bold text-stone-800">{formatDuration(route.duration)}</p>
                </div>
                <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-100/50">
                  <div className="flex items-center gap-2 text-emerald-600/60 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">消耗热量</span>
                  </div>
                  <p className="text-lg font-bold text-emerald-700">{route.calories} kcal</p>
                </div>
                <div className="p-3 bg-blue-50/50 rounded-xl border border-blue-100/50">
                  <div className="flex items-center gap-2 text-blue-600/60 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">减排 CO₂</span>
                  </div>
                  <p className="text-lg font-bold text-blue-700">{route.co2Saved} kg</p>
                </div>
                <div className="p-3 bg-orange-50/50 rounded-xl border border-orange-100/50">
                  <div className="flex items-center gap-2 text-orange-600/60 mb-1">
                    <TrendingUp className="w-3.5 h-3.5" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">最大坡度</span>
                  </div>
                  <p className="text-lg font-bold text-orange-700">{Math.abs(route.maxGrade).toFixed(1)}%</p>
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

        <div className="p-4 border-t border-stone-100 bg-stone-50/50 space-y-2">
          {route && (
            <button
              onClick={syncToDevice}
              disabled={syncing}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold transition-all shadow-lg active:scale-[0.98]",
                syncSuccess 
                  ? "bg-emerald-500 text-white" 
                  : "bg-stone-900 hover:bg-stone-800 text-white"
              )}
            >
              {syncing ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : syncSuccess ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <Cpu className="w-4 h-4" />
              )}
              {syncSuccess ? "已同步到云端" : "同步到 ESP32"}
            </button>
          )}
          <button
            onClick={reset}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-white border border-stone-200 hover:bg-stone-50 text-stone-600 rounded-xl font-semibold transition-all active:scale-[0.98]"
          >
            <RotateCcw className="w-4 h-4" />
            重置地图
          </button>
        </div>
      </div>

      {/* Map Container */}
      <div className="flex-1 relative z-10">
        <MapContainer
          center={[39.9042, 116.4074]}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://amap.com/">高德地图</a>'
            url="http://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}"
            subdomains={['1', '2', '3', '4']}
          />
          
          <MapEvents onMapClick={handleMapClick} />
          <LocateControl onLocate={setUserLocation} />
          
          {userLocation && (
            <Marker 
              position={userLocation}
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
            <Marker position={startPoint}>
              <Popup>起点</Popup>
            </Marker>
          )}
          
          {endPoint && (
            <Marker position={endPoint}>
              <Popup>终点</Popup>
            </Marker>
          )}

          {route && (
            <>
              {/* 路线主体 */}
              <Polyline 
                positions={route.coordinates} 
                color="#10b981" 
                weight={6} 
                opacity={0.8}
                lineJoin="round"
                className="route-line-animated"
              />

              <FitBounds points={route.coordinates} />
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
