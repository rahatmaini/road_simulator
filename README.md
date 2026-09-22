# Traffic Simulator

A browser-based highway traffic simulator built with plain HTML/CSS/JS and an HTML5 canvas.

**[Live demo](https://rahatm.com/road_simulator/)**

## Features

- Configurable lanes, road length, number of exits, initial car count, and speed limit (mph)
- "Left lane for passing only" rule, with cars merging back right once they're no longer actually gaining on traffic ahead
- Realistic car-following physics (Intelligent Driver Model) with a configurable minimum following gap
- Driver reaction delay setting that reproduces real "phantom" traffic jams — small slowdowns amplify into backward-traveling stop-and-go waves in dense traffic
- Spawn a car on demand into any lane, at any speed, exiting wherever you choose
- Smoothly eased lane changes, brake lights, exit-ramp glide/fade, and car spawn-in animations
- "Keep car count constant" option that respawns a car whenever one leaves the road
- Live per-lane "cars out/sec" throughput readout at the end of each lane

## Running locally

Just open `index.html` in a browser, or serve the folder with any static file server:

```bash
python3 -m http.server 8000
```
