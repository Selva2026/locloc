
    const serverUrl = window.location.origin;
    let map = null;
    let marker = null;
    let accCircle = null;
    let polyline = null;
    let pathCoords = [];
    let autoPan = true;
    let totalPings = 0;

    function initMap() {
      const defaultCenter = [13.0827, 80.2707];
      map = L.map('map', { zoomControl: false }).setView(defaultCenter, 14);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);

      L.control.zoom({ position: 'bottomleft' }).addTo(map);

      const pulseIcon = L.divIcon({
        className: 'pulsing-marker',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      marker = L.marker(defaultCenter, { icon: pulseIcon }).addTo(map);
      accCircle = L.circle(defaultCenter, { radius: 10, color: '#3b82f6', fillOpacity: 0.15, weight: 1 }).addTo(map);

      polyline = L.polyline([], { color: '#38bdf8', weight: 4, opacity: 0.85, smoothFactor: 1 }).addTo(map);

      // Load initial past history from server
      fetch(serverUrl + '/api/location/history?limit=100')
        .then(r => r.json())
        .then(data => {
          if (data.storage === 'mongodb') {
            document.getElementById('dbBadge').innerText = 'MongoDB Atlas';
            document.getElementById('dbBadge').className = 'db-badge';
          } else {
            document.getElementById('dbBadge').innerText = 'Local Storage';
            document.getElementById('dbBadge').className = 'db-badge file';
          }

          if (data.locations && data.locations.length > 0) {
            data.locations.forEach(pt => addPointToMap(pt, false));
            const last = data.locations[data.locations.length - 1];
            updateHUD(last);
            map.setView([last.coordinates.latitude, last.coordinates.longitude], 16);
          }
        })
        .catch(err => console.log('History init:', err));
    }

    function addPointToMap(record, shouldPan = true) {
      const lat = record.coordinates.latitude;
      const lng = record.coordinates.longitude;
      const acc = record.coordinates.accuracy || 10;

      pathCoords.push([lat, lng]);
      polyline.setLatLngs(pathCoords);

      marker.setLatLng([lat, lng]);
      accCircle.setLatLng([lat, lng]);
      accCircle.setRadius(acc);

      if (autoPan && shouldPan) {
        map.panTo([lat, lng]);
      }

      totalPings++;
      document.getElementById('pingCountBadge').innerText = totalPings + ' Pings';
      appendTableRow(record);
    }

    function updateHUD(record) {
      const c = record.coordinates;
      document.getElementById('latVal').innerText = c.latitude.toFixed(6);
      document.getElementById('lngVal').innerText = c.longitude.toFixed(6);
      document.getElementById('speedVal').innerText = (c.speedKmH || 0).toFixed(1);
      document.getElementById('accVal').innerText = '±' + Math.round(c.accuracy) + 'm';
      document.getElementById('altVal').innerText = c.altitude !== null ? Math.round(c.altitude) + 'm' : '--';
      document.getElementById('deviceVal').innerText = record.deviceId || 'Phone';
      document.getElementById('lastSeenVal').innerText = new Date(record.receivedAt || Date.now()).toLocaleTimeString();
    }

    function appendTableRow(record) {
      const tbody = document.getElementById('logsTable');
      if (totalPings === 1) {
        tbody.innerHTML = '';
      }
      const time = new Date(record.receivedAt || Date.now()).toLocaleTimeString();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${time}</td>
        <td>${record.coordinates.latitude.toFixed(5)}</td>
        <td>${record.coordinates.longitude.toFixed(5)}</td>
        <td>±${Math.round(record.coordinates.accuracy)}m</td>
      `;
      tbody.insertBefore(tr, tbody.firstChild);
      while (tbody.children.length > 25) {
        tbody.removeChild(tbody.lastChild);
      }
    }

    function setupStream() {
      const liveDot = document.getElementById('liveDot');
      const connStatus = document.getElementById('connStatus');

      const sse = new EventSource(serverUrl + '/api/location/stream');

      sse.onopen = () => {
        liveDot.classList.add('active');
        connStatus.innerText = 'Connected & Listening';
      };

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'location' && data.payload) {
            if (data.payload.receivedAt) {
              lastKnownRecordTime = new Date(data.payload.receivedAt).getTime();
            }
            handleNewLocationRecord(data.payload);
          } else if (data.type === 'cleared') {
            pathCoords = [];
            polyline.setLatLngs([]);
            totalPings = 0;
            document.getElementById('logsTable').innerHTML = '<tr><td colspan="4" style="text-align: center; color: #6b7280; padding: 12px;">Waiting for first GPS ping...</td></tr>';
            document.getElementById('pingCountBadge').innerText = '0 Pings';
          }
        } catch (e) {
          console.error('SSE Error:', e);
        }
      };

      sse.onerror = () => {
        liveDot.classList.remove('active');
        connStatus.innerText = 'Reconnecting...';
      };
    }

    function recenterMap() {
      if (marker) {
        map.setView(marker.getLatLng(), 17);
      }
    }

    function toggleAutoPan() {
      autoPan = !autoPan;
      document.getElementById('followState').innerText = autoPan ? 'ON' : 'OFF';
    }

    function copyApiUrl() {
      const urlText = document.getElementById('endpointCode').innerText;
      navigator.clipboard.writeText(urlText).then(() => {
        alert('Endpoint URL copied to clipboard:\n' + urlText);
      });
    }

    function clearHistory() {
      if (confirm('Clear all location history from server?')) {
        fetch(serverUrl + '/api/location/history', { method: 'DELETE' });
      }
    }

    let isFetching = false;
    let fetchTimeoutTimer = null;
    let lastKnownRecordTime = 0;

    function handleNewLocationRecord(payload) {
      if (!payload || !payload.coordinates) return;
      addPointToMap(payload, true);
      updateHUD(payload);

      if (isFetching) {
        isFetching = false;
        if (fetchTimeoutTimer) clearTimeout(fetchTimeoutTimer);
        const btns = [document.getElementById('fetchLocBtn'), document.getElementById('hudFetchLocBtn')];
        btns.forEach(b => {
          if (b) {
            b.disabled = false;
            b.classList.remove('loading');
            b.innerText = '? Location Received!';
            setTimeout(() => {
              b.innerText = '?? Fetch Location Now';
            }, 3500);
          }
        });
        document.getElementById('connStatus').innerText = 'Live GPS Received just now!';
      }
    }

    async function requestDeviceLocation() {
      if (isFetching) return;
      isFetching = true;

      const clickTimestamp = Date.now();
      const btns = [document.getElementById('fetchLocBtn'), document.getElementById('hudFetchLocBtn')];
      btns.forEach(b => {
        if (b) {
          b.disabled = true;
          b.classList.add('loading');
          b.innerText = '? Requesting Device...';
        }
      });
      document.getElementById('connStatus').innerText = 'Command sent! Waiting for GPS response...';

      try {
        const res = await fetch('/api/location/request', { method: 'POST' });
        const data = await res.json();
        console.log('Fetch dispatched to server:', data);

        // Active 2-second HTTP polling fallback alongside SSE
        const pollInterval = setInterval(async () => {
          if (!isFetching) {
            clearInterval(pollInterval);
            return;
          }
          try {
            const r = await fetch('/api/location/latest');
            if (r.ok) {
              const latest = await r.json();
              if (latest && latest.receivedAt) {
                const recTime = new Date(latest.receivedAt).getTime();
                if (recTime >= clickTimestamp - 2000 && recTime > lastKnownRecordTime) {
                  lastKnownRecordTime = recTime;
                  clearInterval(pollInterval);
                  handleNewLocationRecord(latest);
                }
              }
            }
          } catch (pe) {}
        }, 2000);

        // Reset if no response within 25 seconds
        if (fetchTimeoutTimer) clearTimeout(fetchTimeoutTimer);
        fetchTimeoutTimer = setTimeout(() => {
          if (isFetching) {
            isFetching = false;
            clearInterval(pollInterval);
            btns.forEach(b => {
              if (b) {
                b.disabled = false;
                b.classList.remove('loading');
                b.innerText = '?? Fetch Location Now';
              }
            });
            document.getElementById('connStatus').innerText = 'Phone has not responded yet (may be sleeping/offline)';
          }
        }, 25000);
      } catch (e) {
        console.error('Fetch error:', e);
        isFetching = false;
        btns.forEach(b => {
          if (b) {
            b.disabled = false;
            b.classList.remove('loading');
            b.innerText = '?? Fetch Location Now';
          }
        });
      }
    }

    window.onload = () => {
      const codeElem = document.getElementById('endpointCode');
      if (codeElem) {
        codeElem.innerText = window.location.origin + '/api/location';
      }
      initMap();
      setupStream();
    };
  
