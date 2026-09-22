'use strict';

/* ---------- Constants ---------- */
const CAR_LENGTH = 4.5;        // meters, used for gap math
const CAR_WIDTH_PX = 16;       // min visual width of a car
const CAR_HEIGHT_PX = 10;
let MIN_GAP_METERS = 4.5;      // meters, bumper-to-bumper minimum; set from the "minimum gap" road setting
const HEADWAY_T = 1.4;         // seconds, desired time headway
const MAX_ACCEL = 2.5;         // m/s^2
const COMFORT_DECEL = 4.5;     // m/s^2
const LANE_CHANGE_COOLDOWN = 3;    // seconds
const LANE_CHECK_INTERVAL = 0.4;   // seconds
const EXIT_MERGE_DISTANCE = 450;   // meters, start trying to merge right this far from exit
const SPAWN_CLEAR_ZONE = 25;       // meters, must be clear near x=0 to spawn
const PASS_SPEED_MARGIN = 1.5;     // m/s, how much faster than the car being passed counts as "actually passing"
const SPEED_MAINTAIN_DEFICIT = 2;  // m/s, how far under its target speed a car tolerates before hunting for a faster lane
const CHART_WINDOW_SECONDS = 180;  // seconds of simulated time visible in the traffic-health chart
const CHART_SAMPLE_INTERVAL = 1;   // seconds between per-lane speed samples recorded for the chart
const MAX_EVENTS = 80;             // cap on stored condition-change markers
const LANE_COLORS = ['#4f8cff', '#ff8c4f', '#4fd18c', '#e05c8a', '#d1c94f', '#a26fe0'];

const MPH_PER_MS = 2.2369362921;   // 1 m/s in mph
const LANE_CHANGE_ANIM_DURATION = 0.8; // seconds for the visual lane-change glide
const BRAKE_ACCEL_THRESHOLD = -0.6;    // m/s^2, below this the brake lights light up
const BRAKE_LIGHT_EASE_RATE = 8;       // per-second approach rate easing brake-light brightness toward on/off
const EXIT_ANIM_DURATION = 1.4;        // seconds for a car to glide down the ramp and fade
const SPAWN_ANIM_DURATION = 0.5;       // seconds for a newly spawned car to ease in (fade + grow)
const HISTORY_MAX_AGE = 3.0;           // seconds of position/speed history kept per car, for reaction-delay lookups

/* ---------- Easing ---------- */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeInCubic(t) {
  return t * t * t;
}

// Simulation clock, advanced each step() call. Used to time-stamp car history
// so a following car can react to how the leader looked `reactionDelay` seconds
// ago instead of instantaneously - this delayed reaction is what lets a small
// perturbation amplify into a backward-traveling "phantom" traffic jam, per
// https://nautil.us/why-a-traffic-flow-suddenly-turns-into-a-traffic-jam-234429
let simClock = 0;

/* ---------- Global sim state ---------- */
let state = {
  lanes: 3,
  roadLength: 3000,
  numExits: 3,
  exitPositions: [],
  speedLimitMph: 65,
  minGapCarLengths: 1,
  reactionDelay: 1.0,
  passingOnly: false,
  maintainCount: false,
  pendingSpawns: 0,
  timeScale: 2,
  running: true,
  cars: [],
  nextCarId: 1,
  laneSpeedHistory: [],  // {t, speeds: [avgMph per lane, or null if that lane was empty]}
  chartSampleTimer: 0,
  events: [],             // {t, type: 'settings'|'spawn'|'reset', label, detail}
};

const canvas = document.getElementById('roadCanvas');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const statsEl = document.getElementById('stats');
const spawnMsg = document.getElementById('spawnMsg');
const chartCanvas = document.getElementById('flowChart');
const chartCtx = chartCanvas.getContext('2d');
const chartTooltip = document.getElementById('chartTooltip');

let isInitialBuild = true;

/* ---------- Car ---------- */
class Car {
  constructor(id, lane, position, speedMph, desiredMph, exitDistance, color) {
    this.id = id;
    this.lane = lane;                     // 0 = leftmost (logical, changes instantly)
    this.visualLane = lane;               // eased render position, chases `lane`
    this.laneAnimFrom = lane;             // lane-change ease-in-out state
    this.laneAnimTarget = lane;
    this.laneAnimProgress = 1;            // 1 = animation settled
    this.position = position;             // meters along road
    this.speed = speedMph / MPH_PER_MS;   // m/s
    this.desiredSpeed = desiredMph / MPH_PER_MS; // m/s target cruise speed
    this.exitDistance = exitDistance;     // meters, or null = drive to end
    this.color = color;
    this.laneChangeCooldown = Math.random() * LANE_CHANGE_COOLDOWN;
    this.laneCheckTimer = Math.random() * LANE_CHECK_INTERVAL;
    this.braking = false;
    this.brakeIntensity = 0;              // eased 0-1, smooths the brake-light on/off toggle
    this.exiting = false;                 // true while gliding down an exit ramp
    this.exitAnimTimer = 0;
    this.spawnAnimTimer = 0;              // eases the car in (fade + grow) when first created
    // each driver reacts a little differently; some are slower to notice
    // the car ahead braking, which is what seeds phantom jams
    this.reactionDelay = Math.max(0, state.reactionDelay * (0.7 + Math.random() * 0.6));
    this.history = [{ t: simClock, position, speed: this.speed }];
  }
}

// Returns { position, speed } for `car` as it was at simulation time `t`,
// linearly interpolated from its recorded history (clamped to the oldest/newest sample).
function sampleHistory(car, t) {
  const h = car.history;
  const last = h[h.length - 1];
  if (t >= last.t) return last;
  const first = h[0];
  if (t <= first.t) return first;
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (a.t <= t && t <= b.t) {
      const span = b.t - a.t;
      const frac = span > 0 ? (t - a.t) / span : 0;
      return {
        position: a.position + (b.position - a.position) * frac,
        speed: a.speed + (b.speed - a.speed) * frac,
      };
    }
  }
  return last;
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 60%)`;
}

/* ---------- Setup / rebuild ---------- */
function computeExitPositions(numExits, roadLength) {
  const positions = [];
  for (let i = 1; i <= numExits; i++) {
    positions.push(Math.round((roadLength * i) / (numExits + 1)));
  }
  return positions;
}

// Captures the settings that matter for traffic behavior, so a rebuild can
// report exactly what changed as a marker on the traffic-health chart.
function snapshotSettings() {
  return {
    lanes: state.lanes,
    roadLength: state.roadLength,
    numExits: state.numExits,
    speedLimitMph: state.speedLimitMph,
    minGapCarLengths: state.minGapCarLengths,
    reactionDelay: state.reactionDelay,
    passingOnly: state.passingOnly,
    maintainCount: state.maintainCount,
  };
}

function diffSettings(before, after) {
  const changes = [];
  if (before.lanes !== after.lanes) changes.push(`Lanes ${before.lanes}\u2192${after.lanes}`);
  if (before.roadLength !== after.roadLength) changes.push(`Road length ${before.roadLength}\u2192${after.roadLength} m`);
  if (before.numExits !== after.numExits) changes.push(`Exits ${before.numExits}\u2192${after.numExits}`);
  if (before.speedLimitMph !== after.speedLimitMph) changes.push(`Speed limit ${before.speedLimitMph}\u2192${after.speedLimitMph} mph`);
  if (before.minGapCarLengths !== after.minGapCarLengths) changes.push(`Min gap ${before.minGapCarLengths}\u2192${after.minGapCarLengths} car lengths`);
  if (before.reactionDelay !== after.reactionDelay) changes.push(`Reaction delay ${before.reactionDelay}\u2192${after.reactionDelay}s`);
  if (before.passingOnly !== after.passingOnly) changes.push(`Passing-only lane ${before.passingOnly ? 'On' : 'Off'}\u2192${after.passingOnly ? 'On' : 'Off'}`);
  if (before.maintainCount !== after.maintainCount) changes.push(`Keep count constant ${before.maintainCount ? 'On' : 'Off'}\u2192${after.maintainCount ? 'On' : 'Off'}`);
  return changes;
}

function pushEvent(type, label, detail) {
  state.events.push({ t: simClock, type, label, detail });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

function rebuildRoad() {
  const before = snapshotSettings();

  state.lanes = clampInt(document.getElementById('lanesInput').value, 1, 6);
  state.roadLength = clampInt(document.getElementById('roadLengthInput').value, 200, 50000);
  state.numExits = clampInt(document.getElementById('exitsInput').value, 0, 10);
  state.speedLimitMph = clampInt(document.getElementById('speedLimitInput').value, 10, 150);
  state.minGapCarLengths = clampNum(parseFloat(document.getElementById('minGapInput').value) || 1, 0.2, 5);
  state.reactionDelay = clampNum(parseFloat(document.getElementById('reactionDelayInput').value) || 0, 0, 2.5);
  state.passingOnly = document.getElementById('passingOnlyCheckbox').checked;
  state.maintainCount = document.getElementById('maintainCountCheckbox').checked;

  document.getElementById('lanesInput').value = state.lanes;
  document.getElementById('roadLengthInput').value = state.roadLength;
  document.getElementById('exitsInput').value = state.numExits;
  document.getElementById('speedLimitInput').value = state.speedLimitMph;
  document.getElementById('minGapInput').value = state.minGapCarLengths;
  document.getElementById('reactionDelayInput').value = state.reactionDelay;

  MIN_GAP_METERS = state.minGapCarLengths * CAR_LENGTH;
  state.exitPositions = computeExitPositions(state.numExits, state.roadLength);

  if (isInitialBuild) {
    // first-ever build: nothing to preserve yet, start the chart's timeline fresh
    simClock = 0;
    state.laneSpeedHistory = [];
    state.events = [];
    state.chartSampleTimer = 0;
  } else {
    // subsequent rebuilds keep the chart's history going and just mark what changed,
    // so applying settings never erases what you were already watching
    const changes = diffSettings(before, snapshotSettings());
    if (changes.length > 0) pushEvent('settings', 'Settings changed', changes.join(', '));
  }
  isInitialBuild = false;

  const carCount = clampInt(document.getElementById('carCountInput').value, 0, 300);
  state.pendingSpawns = 0;
  spawnInitialTraffic(carCount);

  populateSpawnLaneOptions();
  populateSpawnExitOptions();
  resizeCanvas();
  resizeChartCanvas();
  updateChartLegend();
}

function resetTrafficOnly() {
  simClock = 0;
  state.laneSpeedHistory = [];
  state.events = [];
  state.chartSampleTimer = 0;
  pushEvent('reset', 'Traffic reset', 'Cars respawned with current settings');
  const carCount = clampInt(document.getElementById('carCountInput').value, 0, 300);
  state.pendingSpawns = 0;
  spawnInitialTraffic(carCount);
}

function spawnInitialTraffic(count) {
  state.cars = [];
  state.nextCarId = 1;

  // distribute across lanes round robin, spaced out along the road per lane
  const perLane = Array.from({ length: state.lanes }, () => []);
  for (let i = 0; i < count; i++) {
    perLane[i % state.lanes].push(i);
  }

  // every car must be able to reach an exit, so keep initial spawn positions
  // from landing past the last one (when exits exist)
  const maxSpawnPos = state.exitPositions.length > 0
    ? Math.max(0, Math.min(state.roadLength * 0.95, state.exitPositions[state.exitPositions.length - 1] - 150))
    : state.roadLength * 0.95;

  perLane.forEach((indices, lane) => {
    const n = indices.length;
    indices.forEach((idx, k) => {
      const slot = (k + 1) / (n + 1);
      const jitter = (Math.random() - 0.5) * (state.roadLength / (n + 2)) * 0.5;
      let position = clampNum(state.roadLength * slot * 0.9 + jitter, 0, maxSpawnPos);
      const desiredMph = state.speedLimitMph * (0.88 + Math.random() * 0.2);
      const exitDistance = pickRandomExitFor(position);
      const car = new Car(state.nextCarId++, lane, position, desiredMph, desiredMph, exitDistance, randomColor());
      state.cars.push(car);
    });
  });
}

// Every car must leave via an exit, so this always assigns one of the exits
// still ahead of `startPosition`. Only returns null if none exist (no exits
// configured at all, or the car has already passed the last one) - the sole
// case where driving to the end of the road is unavoidable.
function pickRandomExitFor(startPosition) {
  const validExits = state.exitPositions.filter(e => e > startPosition + 100);
  if (validExits.length === 0) return null;
  return validExits[Math.floor(Math.random() * validExits.length)];
}

function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (isNaN(v)) v = min;
  return Math.min(max, Math.max(min, v));
}
function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/* ---------- Spawn dropdowns ---------- */
function populateSpawnLaneOptions() {
  const sel = document.getElementById('spawnLane');
  sel.innerHTML = '';
  for (let i = 0; i < state.lanes; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    let label = `Lane ${i + 1}`;
    if (i === 0) label += state.lanes > 1 ? ' (leftmost' + (state.passingOnly ? ' \u2013 passing only' : '') + ')' : '';
    if (i === state.lanes - 1 && state.lanes > 1) label += ' (rightmost \u2013 exits)';
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

// Every car must leave via an exit, so "drive to end of road" is only offered
// when the road genuinely has no exits configured to pick from.
function populateSpawnExitOptions() {
  const sel = document.getElementById('spawnExit');
  sel.innerHTML = '';
  if (state.exitPositions.length === 0) {
    const endOpt = document.createElement('option');
    endOpt.value = 'end';
    endOpt.textContent = 'Drive to end of road (no exits configured)';
    sel.appendChild(endOpt);
    return;
  }
  state.exitPositions.forEach((pos, i) => {
    const opt = document.createElement('option');
    opt.value = pos;
    opt.textContent = `Exit ${i + 1} (at ${pos} m)`;
    sel.appendChild(opt);
  });
}

/* ---------- Manual spawn ---------- */
function spawnManualCar() {
  const lane = clampInt(document.getElementById('spawnLane').value, 0, state.lanes - 1);
  const speedMph = clampNum(parseFloat(document.getElementById('spawnSpeed').value) || 0, 0, 150);
  const exitVal = document.getElementById('spawnExit').value;
  const exitDistance = exitVal === 'end' ? null : parseFloat(exitVal);

  // check entrance is clear
  const blocked = state.cars.some(c => c.lane === lane && c.position < SPAWN_CLEAR_ZONE);
  if (blocked) {
    spawnMsg.textContent = 'Lane entrance is busy \u2014 try again in a moment.';
    spawnMsg.className = 'msg';
    return;
  }

  const car = new Car(state.nextCarId++, lane, 0, speedMph, speedMph, exitDistance, randomColor());
  state.cars.push(car);
  spawnMsg.textContent = `Spawned car #${car.id} in lane ${lane + 1} at ${speedMph} mph.`;
  spawnMsg.className = 'msg ok';
  setTimeout(() => { spawnMsg.textContent = ''; }, 3000);

  const exitDesc = exitDistance !== null ? `exiting at ${exitDistance} m` : 'driving to end of road';
  pushEvent('spawn', 'Car spawned', `Lane ${lane + 1} at ${speedMph} mph, ${exitDesc}`);
}

/* ---------- Physics: IDM car-following ---------- */
function idmAccel(v, v0, gap, deltaV) {
  const s0 = MIN_GAP_METERS;
  const T = HEADWAY_T;
  const a = MAX_ACCEL;
  const b = COMFORT_DECEL;
  const safeV0 = Math.max(v0, 0.1);

  if (gap === Infinity) {
    return a * (1 - Math.pow(v / safeV0, 4));
  }
  const sStar = s0 + Math.max(0, v * T + (v * deltaV) / (2 * Math.sqrt(a * b)));
  const safeGap = Math.max(gap, 0.1);
  const accel = a * (1 - Math.pow(v / safeV0, 4) - Math.pow(sStar / safeGap, 2));
  return accel;
}

function findLeader(car, lane, cars) {
  let best = null;
  let bestGap = Infinity;
  for (const other of cars) {
    if (other === car || other.lane !== lane) continue;
    const gap = other.position - car.position - CAR_LENGTH;
    if (gap >= -CAR_LENGTH && gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
  return best;
}

function findFollower(car, lane, cars) {
  let best = null;
  let bestGap = Infinity;
  for (const other of cars) {
    if (other === car || other.lane !== lane) continue;
    const gap = car.position - other.position - CAR_LENGTH;
    if (gap >= -CAR_LENGTH && gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
  return best;
}

function canChangeTo(car, targetLane, cars) {
  if (targetLane < 0 || targetLane >= state.lanes) return false;
  const leader = findLeader(car, targetLane, cars);
  const follower = findFollower(car, targetLane, cars);
  const frontGap = leader ? leader.position - car.position - CAR_LENGTH : Infinity;
  const rearGap = follower ? car.position - follower.position - CAR_LENGTH : Infinity;
  const minFront = Math.max(MIN_GAP_METERS + 1.5, car.speed * 0.8);
  const minRear = Math.max(MIN_GAP_METERS + 1.5, (follower ? follower.speed : 0) * 0.8);
  return frontGap > minFront && rearGap > minRear;
}

function laneChangeAccelGain(car, targetLane, cars) {
  const leader = findLeader(car, targetLane, cars);
  const gap = leader ? leader.position - car.position - CAR_LENGTH : Infinity;
  const deltaV = leader ? car.speed - leader.speed : 0;
  return idmAccel(car.speed, car.desiredSpeed, gap, deltaV);
}

function updateLaneDecision(car, cars) {
  if (car.laneChangeCooldown > 0 || state.lanes <= 1) return;

  const hasExit = car.exitDistance !== null;
  const distToExit = hasExit ? car.exitDistance - car.position : Infinity;

  // 1. Priority: merge right to make an exit
  if (hasExit && distToExit < EXIT_MERGE_DISTANCE && distToExit > -50 && car.lane < state.lanes - 1) {
    if (canChangeTo(car, car.lane + 1, cars)) {
      car.lane += 1;
      car.laneChangeCooldown = LANE_CHANGE_COOLDOWN;
      return;
    }
    // urgent and close: accept a smaller gap
    if (distToExit < 120) {
      const leader = findLeader(car, car.lane + 1, cars);
      const follower = findFollower(car, car.lane + 1, cars);
      const frontGap = leader ? leader.position - car.position - CAR_LENGTH : Infinity;
      const rearGap = follower ? car.position - follower.position - CAR_LENGTH : Infinity;
      if (frontGap > 4 && rearGap > 3) {
        car.lane += 1;
        car.laneChangeCooldown = LANE_CHANGE_COOLDOWN;
        return;
      }
    }
    return; // focused on merging, skip other lane logic this cycle
  }

  const leader = findLeader(car, car.lane, cars);
  const currentAccel = laneChangeAccelGain(car, car.lane, cars);
  // "blocked" also covers a car that's meaningfully under its own target speed and
  // not actively closing that gap - it should go hunting for a faster lane rather
  // than just sitting there, so a spawned-in target speed is treated as a floor
  // to defend with whatever maneuver is available, not just a cruise suggestion.
  const speedDeficit = car.desiredSpeed - car.speed;
  const hardBraking = leader !== null && currentAccel < -0.8;
  const laggingTarget = leader !== null && speedDeficit > SPEED_MAINTAIN_DEFICIT && currentAccel < 0.3;
  const blocked = hardBraking || laggingTarget;

  // 2. Overtake: move left if blocked and left lane is better
  if (blocked && car.lane > 0) {
    const gain = laneChangeAccelGain(car, car.lane - 1, cars);
    if (gain > currentAccel + 0.4 && canChangeTo(car, car.lane - 1, cars)) {
      car.lane -= 1;
      car.laneChangeCooldown = LANE_CHANGE_COOLDOWN;
      return;
    }
  }

  // 3. Return to the right once you're not actually gaining on the car ahead
  // of you in that lane. This is the general "passing lane" contract for any
  // lane change to the left: you moved over to get past whoever was blocking
  // you, and you stay only as long as you're genuinely faster than whoever is
  // now the next car up in the lane to your right - which is either the car
  // you're still overtaking, or (once you've cleared it) the next one worth
  // passing before you have to get back over. Applies to every lane, not just
  // the designated passing lane, so any leftward move is always purposeful.
  if (!blocked && car.lane < state.lanes - 1) {
    const rightLeader = findLeader(car, car.lane + 1, cars);
    const isPassing = rightLeader !== null && car.speed > rightLeader.speed + PASS_SPEED_MARGIN;
    if (!isPassing && canChangeTo(car, car.lane + 1, cars)) {
      car.lane += 1;
      car.laneChangeCooldown = LANE_CHANGE_COOLDOWN;
    }
  }
}

/* ---------- Visual lane-change animation ---------- */
function updateVisualLane(car, dt) {
  // logical lane changed (or changed again mid-glide) - restart the ease from
  // wherever the car is currently rendered, so back-to-back changes stay smooth
  if (car.lane !== car.laneAnimTarget) {
    car.laneAnimFrom = car.visualLane;
    car.laneAnimTarget = car.lane;
    car.laneAnimProgress = 0;
  }
  if (car.laneAnimProgress < 1) {
    car.laneAnimProgress = Math.min(1, car.laneAnimProgress + dt / LANE_CHANGE_ANIM_DURATION);
    const eased = easeInOutCubic(car.laneAnimProgress);
    car.visualLane = car.laneAnimFrom + (car.laneAnimTarget - car.laneAnimFrom) * eased;
  } else {
    car.visualLane = car.laneAnimTarget;
  }
}

/* ---------- Simulation step ---------- */
function step(dt) {
  simClock += dt;
  const cars = state.cars;
  // cars actively gliding down an exit ramp no longer interact with traffic
  const activeCars = cars.filter(c => !c.exiting);

  // lane decisions + visual lane animation
  for (const car of activeCars) {
    car.laneCheckTimer -= dt;
    car.laneChangeCooldown = Math.max(0, car.laneChangeCooldown - dt);
    if (car.laneCheckTimer <= 0) {
      car.laneCheckTimer = LANE_CHECK_INTERVAL;
      updateLaneDecision(car, activeCars);
    }
    updateVisualLane(car, dt);
    if (car.spawnAnimTimer < SPAWN_ANIM_DURATION) car.spawnAnimTimer += dt;
  }

  // physics: each driver reacts to how the gap/relative speed looked
  // `reactionDelay` seconds ago, not to the instantaneous situation. That lag
  // is what lets a small slow-down amplify into a phantom jam as it propagates
  // backward through tightly-spaced traffic.
  for (const car of activeCars) {
    const leader = findLeader(car, car.lane, activeCars);
    let gap = Infinity;
    let deltaV = 0;
    if (leader) {
      const perceivedT = simClock - car.reactionDelay;
      const leaderPast = sampleHistory(leader, perceivedT);
      const selfPast = sampleHistory(car, perceivedT);
      gap = leaderPast.position - selfPast.position - CAR_LENGTH;
      deltaV = selfPast.speed - leaderPast.speed;
    }
    let accel = idmAccel(car.speed, car.desiredSpeed, gap, deltaV);
    accel = clampNum(accel, -8, MAX_ACCEL * 1.2);
    car.braking = accel < BRAKE_ACCEL_THRESHOLD;
    const brakeTarget = car.braking ? 1 : 0;
    car.brakeIntensity += (brakeTarget - car.brakeIntensity) * Math.min(1, BRAKE_LIGHT_EASE_RATE * dt);
    car.speed = Math.max(0, car.speed + accel * dt);
    car.position += car.speed * dt;
  }

  // record history for delayed-reaction lookups, and trim old samples
  for (const car of activeCars) {
    car.history.push({ t: simClock, position: car.position, speed: car.speed });
    const cutoff = simClock - HISTORY_MAX_AGE;
    while (car.history.length > 2 && car.history[1].t < cutoff) car.history.shift();
  }

  // detect a car reaching its exit (or missing it) this frame
  for (const car of activeCars) {
    if (car.exitDistance !== null && car.position >= car.exitDistance) {
      if (car.lane === state.lanes - 1) {
        car.exiting = true;
        car.exitAnimTimer = 0;
        car.braking = false;
        car.brakeIntensity = 0;
      } else {
        // missed this one - every car must exit somewhere, so aim for the next
        // exit ahead instead of giving up; only null if none remain
        car.exitDistance = pickRandomExitFor(car.position);
      }
    }
  }

  // progress ramp glide/fade animations
  for (const car of cars) {
    if (car.exiting) car.exitAnimTimer += dt;
  }

  // remove cars that finished exiting or reached the end of the road
  const beforeCount = cars.length;
  state.cars = cars.filter(car => {
    if (car.exiting) return car.exitAnimTimer < EXIT_ANIM_DURATION;
    return car.position < state.roadLength;
  });
  const departedCount = beforeCount - state.cars.length;

  if (state.maintainCount && departedCount > 0) {
    state.pendingSpawns += departedCount;
  }
  if (state.maintainCount && state.pendingSpawns > 0) {
    attemptAutoSpawns();
  }

  // sample each lane's average speed periodically for the traffic-health chart
  state.chartSampleTimer += dt;
  if (state.chartSampleTimer >= CHART_SAMPLE_INTERVAL) {
    state.chartSampleTimer -= CHART_SAMPLE_INTERVAL;
    const speeds = [];
    for (let lane = 0; lane < state.lanes; lane++) {
      const laneCars = state.cars.filter(c => !c.exiting && c.lane === lane);
      speeds.push(laneCars.length > 0
        ? (laneCars.reduce((s, c) => s + c.speed, 0) / laneCars.length) * MPH_PER_MS
        : null);
    }
    state.laneSpeedHistory.push({ t: simClock, speeds });
    const cutoff = simClock - CHART_WINDOW_SECONDS - 10;
    while (state.laneSpeedHistory.length > 2 && state.laneSpeedHistory[0].t < cutoff) state.laneSpeedHistory.shift();
  }
}

// Replaces cars that left the road (took an exit or reached the end) so the
// total count on the road stays constant, per the "keep car count constant" setting.
function attemptAutoSpawns() {
  for (let lane = 0; lane < state.lanes && state.pendingSpawns > 0; lane++) {
    const blocked = state.cars.some(c => !c.exiting && c.lane === lane && c.position < SPAWN_CLEAR_ZONE);
    if (blocked) continue;
    const desiredMph = state.speedLimitMph * (0.88 + Math.random() * 0.2);
    const exitDistance = pickRandomExitFor(0);
    const car = new Car(state.nextCarId++, lane, 0, desiredMph, desiredMph, exitDistance, randomColor());
    state.cars.push(car);
    state.pendingSpawns -= 1;
  }
}

/* ---------- Rendering ---------- */
let canvasWidth = 900;
let canvasHeight = 400;
const TOP_MARGIN = 40;
const BOTTOM_MARGIN = 50;
let laneHeight = 60;

function resizeCanvas() {
  const area = document.querySelector('.road-area');
  canvasWidth = Math.max(600, area.clientWidth - 24);
  laneHeight = Math.min(70, Math.max(40, 300 / state.lanes));
  canvasHeight = TOP_MARGIN + laneHeight * state.lanes + BOTTOM_MARGIN;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
}

function xForPosition(pos) {
  return (pos / state.roadLength) * canvasWidth;
}

function yForLane(lane) {
  return TOP_MARGIN + lane * laneHeight + laneHeight / 2;
}

function draw() {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // road background
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(0, TOP_MARGIN, canvasWidth, laneHeight * state.lanes);

  // lane dividers
  for (let i = 1; i < state.lanes; i++) {
    const y = TOP_MARGIN + i * laneHeight;
    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // edges
  ctx.strokeStyle = '#ffd54f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, TOP_MARGIN);
  ctx.lineTo(canvasWidth, TOP_MARGIN);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, TOP_MARGIN + laneHeight * state.lanes);
  ctx.lineTo(canvasWidth, TOP_MARGIN + laneHeight * state.lanes);
  ctx.stroke();

  // passing-only highlight on lane 0
  if (state.passingOnly && state.lanes > 1) {
    ctx.fillStyle = 'rgba(79, 140, 255, 0.08)';
    ctx.fillRect(0, TOP_MARGIN, canvasWidth, laneHeight);
    ctx.fillStyle = 'rgba(200, 220, 255, 0.6)';
    ctx.font = '11px sans-serif';
    ctx.fillText('PASSING ONLY', 8, TOP_MARGIN + 14);
  }

  // exits (ramps off the rightmost lane)
  const bottomY = TOP_MARGIN + laneHeight * state.lanes;
  state.exitPositions.forEach((pos, i) => {
    const x = xForPosition(pos);
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, bottomY);
    ctx.lineTo(x + 25, bottomY + 22);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#d9a441';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`Exit ${i + 1}`, x - 12, bottomY + 36);

    // marker line on road
    ctx.strokeStyle = 'rgba(217,164,65,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, TOP_MARGIN);
    ctx.lineTo(x, bottomY);
    ctx.stroke();
  });

  // road end marker
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(canvasWidth - 2, TOP_MARGIN);
  ctx.lineTo(canvasWidth - 2, bottomY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('END', canvasWidth - 32, bottomY + 15);

  // cars
  for (const car of state.cars) {
    if (car.exiting) {
      const t = Math.min(1, car.exitAnimTimer / EXIT_ANIM_DURATION);
      const eased = easeInCubic(t); // accelerates away down the ramp; fade tracks the same curve
      const startX = xForPosition(car.exitDistance);
      const startY = yForLane(state.lanes - 1);
      const endX = startX + 55;
      const endY = bottomY + 40;
      const x = startX + (endX - startX) * eased;
      const y = startY + (endY - startY) * eased;
      drawCar(car, x, y, 1 - eased, 1);
    } else {
      const x = xForPosition(car.position);
      const y = yForLane(car.visualLane);
      const spawnT = Math.min(1, car.spawnAnimTimer / SPAWN_ANIM_DURATION);
      const spawnEase = easeOutCubic(spawnT);
      drawCar(car, x, y, spawnEase, 0.4 + 0.6 * spawnEase);
    }
  }
}

function drawCar(car, x, y, alpha, scale) {
  const w = CAR_WIDTH_PX * scale;
  const h = CAR_HEIGHT_PX * scale;

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.fillStyle = car.color;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 3);
  ctx.fill();

  // brake lights at the rear (cars travel left-to-right, so rear = left edge);
  // brightness eases toward on/off instead of snapping, via car.brakeIntensity
  const lightX = x - w / 2 + 1.5;
  const lightY1 = y - h / 2 + 2;
  const lightY2 = y + h / 2 - 2;
  const bi = car.brakeIntensity;
  const r = Math.round(0x5a + (0xff - 0x5a) * bi);
  const g = Math.round(0x14 + (0x22 - 0x14) * bi);
  const b = Math.round(0x14 + (0x22 - 0x14) * bi);
  ctx.shadowColor = '#ff3333';
  ctx.shadowBlur = 6 * bi;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.beginPath();
  ctx.arc(lightX, lightY1, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lightX, lightY2, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  const speedMph = Math.round(car.speed * MPH_PER_MS);
  ctx.fillStyle = '#ffffff';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${speedMph}`, x, y - h / 2 - 4);
  ctx.textAlign = 'left';

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function updateHudAndStats() {
  hud.innerHTML = `<b>Speed limit:</b> ${state.speedLimitMph} mph &nbsp; | &nbsp; ` +
    `<b>Lanes:</b> ${state.lanes} &nbsp; | &nbsp; ` +
    `<b>Road:</b> ${state.roadLength} m &nbsp; | &nbsp; ` +
    `<b>Min gap:</b> ${state.minGapCarLengths.toFixed(1)} car lengths &nbsp; | &nbsp; ` +
    `<b>Reaction delay:</b> ${state.reactionDelay.toFixed(1)}s &nbsp; | &nbsp; ` +
    `<b>Passing-only left lane:</b> ${state.passingOnly ? 'On' : 'Off'}`;

  const n = state.cars.filter(c => !c.exiting).length;
  const avgSpeed = n > 0
    ? Math.round(state.cars.filter(c => !c.exiting).reduce((s, c) => s + c.speed, 0) / n * MPH_PER_MS)
    : 0;
  const brakingCount = state.cars.filter(c => c.braking).length;
  statsEl.innerHTML = `<b>Cars on road:</b> ${n}<br>` +
    `<b>Average speed:</b> ${avgSpeed} mph<br>` +
    `<b>Braking now:</b> ${brakingCount}<br>` +
    `<b>Exits:</b> ${state.numExits}`;
}

/* ---------- Traffic-health chart ---------- */
let chartWidth = 900;
let chartHeight = 220;
const CHART_LEFT_MARGIN = 40;
const CHART_RIGHT_MARGIN = 12;
const CHART_TOP_MARGIN = 16;
const CHART_BOTTOM_MARGIN = 10;
const EVENT_COLORS = { settings: '#ffb84f', spawn: '#a26fe0', reset: '#8a93a7' };
const EVENT_LABELS = { settings: 'Settings changed', spawn: 'Car spawned', reset: 'Traffic reset' };
let hoverX = null; // mouse x in chart canvas pixels, or null when not hovering

function resizeChartCanvas() {
  const wrap = document.querySelector('.chart-wrap');
  chartWidth = Math.max(400, wrap.clientWidth - 4);
  chartCanvas.width = chartWidth;
  chartCanvas.height = chartHeight;
}

function chartXForTime(t, tMin, tMax) {
  const plotW = chartWidth - CHART_LEFT_MARGIN - CHART_RIGHT_MARGIN;
  return CHART_LEFT_MARGIN + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * plotW;
}

function chartYForSpeed(speed, yMax) {
  const plotH = chartHeight - CHART_TOP_MARGIN - CHART_BOTTOM_MARGIN;
  return CHART_TOP_MARGIN + plotH * (1 - speed / yMax);
}

function updateChartLegend() {
  const legend = document.getElementById('chartLegend');
  let html = '';
  for (let lane = 0; lane < state.lanes; lane++) {
    html += `<span class="legend-item"><span class="legend-swatch" style="background:${LANE_COLORS[lane % LANE_COLORS.length]}"></span>Lane ${lane + 1}</span>`;
  }
  for (const type of ['settings', 'spawn', 'reset']) {
    html += `<span class="legend-item"><span class="legend-swatch dot" style="background:${EVENT_COLORS[type]}"></span>${EVENT_LABELS[type]}</span>`;
  }
  legend.innerHTML = html;
}

function drawChart() {
  chartCtx.clearRect(0, 0, chartWidth, chartHeight);

  const tMax = Math.max(simClock, CHART_WINDOW_SECONDS * 0.05);
  const tMin = Math.max(0, tMax - CHART_WINDOW_SECONDS);
  const yMax = Math.max(20, state.speedLimitMph * 1.2);
  const plotLeft = CHART_LEFT_MARGIN;
  const plotRight = chartWidth - CHART_RIGHT_MARGIN;
  const plotTop = CHART_TOP_MARGIN;
  const plotBottom = chartHeight - CHART_BOTTOM_MARGIN;

  chartCtx.fillStyle = 'rgba(255,255,255,0.03)';
  chartCtx.fillRect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);

  // horizontal gridlines + mph labels
  chartCtx.strokeStyle = 'rgba(255,255,255,0.08)';
  chartCtx.fillStyle = 'rgba(255,255,255,0.4)';
  chartCtx.font = '10px sans-serif';
  chartCtx.textAlign = 'right';
  const step = yMax > 100 ? 25 : yMax > 50 ? 20 : 10;
  for (let v = 0; v <= yMax; v += step) {
    const y = chartYForSpeed(v, yMax);
    chartCtx.beginPath();
    chartCtx.moveTo(plotLeft, y);
    chartCtx.lineTo(plotRight, y);
    chartCtx.stroke();
    chartCtx.fillText(String(v), plotLeft - 6, y + 3);
  }
  chartCtx.textAlign = 'left';

  // speed-limit reference line
  const limitY = chartYForSpeed(state.speedLimitMph, yMax);
  chartCtx.strokeStyle = 'rgba(255, 213, 79, 0.5)';
  chartCtx.setLineDash([4, 4]);
  chartCtx.beginPath();
  chartCtx.moveTo(plotLeft, limitY);
  chartCtx.lineTo(plotRight, limitY);
  chartCtx.stroke();
  chartCtx.setLineDash([]);

  // per-lane average-speed lines (gaps where a lane had no cars)
  for (let lane = 0; lane < state.lanes; lane++) {
    chartCtx.strokeStyle = LANE_COLORS[lane % LANE_COLORS.length];
    chartCtx.lineWidth = 2;
    chartCtx.beginPath();
    let started = false;
    for (const sample of state.laneSpeedHistory) {
      if (sample.t < tMin) continue;
      const v = sample.speeds[lane];
      if (v === null || v === undefined) { started = false; continue; }
      const x = chartXForTime(sample.t, tMin, tMax);
      const y = chartYForSpeed(Math.min(v, yMax), yMax);
      if (!started) { chartCtx.moveTo(x, y); started = true; }
      else chartCtx.lineTo(x, y);
    }
    chartCtx.stroke();
  }

  // condition-change event markers
  let hoveredEvent = null;
  for (const ev of state.events) {
    if (ev.t < tMin || ev.t > tMax) continue;
    const x = chartXForTime(ev.t, tMin, tMax);
    const color = EVENT_COLORS[ev.type] || '#ffffff';
    chartCtx.strokeStyle = color;
    chartCtx.globalAlpha = 0.55;
    chartCtx.setLineDash([3, 3]);
    chartCtx.lineWidth = 1;
    chartCtx.beginPath();
    chartCtx.moveTo(x, plotTop);
    chartCtx.lineTo(x, plotBottom);
    chartCtx.stroke();
    chartCtx.setLineDash([]);
    chartCtx.globalAlpha = 1;
    chartCtx.fillStyle = color;
    chartCtx.beginPath();
    chartCtx.arc(x, plotTop - 5, 3.5, 0, Math.PI * 2);
    chartCtx.fill();

    if (hoverX !== null && Math.abs(hoverX - x) < 6) hoveredEvent = ev;
  }

  // hover crosshair + tooltip
  if (hoverX !== null && hoverX >= plotLeft && hoverX <= plotRight) {
    chartCtx.strokeStyle = 'rgba(255,255,255,0.3)';
    chartCtx.beginPath();
    chartCtx.moveTo(hoverX, plotTop);
    chartCtx.lineTo(hoverX, plotBottom);
    chartCtx.stroke();

    if (hoveredEvent) {
      chartTooltip.innerHTML = `<b>${hoveredEvent.label}</b> @ ${hoveredEvent.t.toFixed(0)}s<br>${hoveredEvent.detail}`;
      chartTooltip.style.display = 'block';
    } else {
      const hoveredT = tMin + ((hoverX - plotLeft) / (plotRight - plotLeft)) * (tMax - tMin);
      let nearest = null, nearestDist = Infinity;
      for (const sample of state.laneSpeedHistory) {
        const d = Math.abs(sample.t - hoveredT);
        if (d < nearestDist) { nearestDist = d; nearest = sample; }
      }
      if (nearest) {
        const lines = nearest.speeds.map((v, i) =>
          `<span style="color:${LANE_COLORS[i % LANE_COLORS.length]}">Lane ${i + 1}: ${v !== null ? Math.round(v) + ' mph' : 'empty'}</span>`
        ).join('<br>');
        chartTooltip.innerHTML = `<b>t = ${nearest.t.toFixed(0)}s</b><br>${lines}`;
        chartTooltip.style.display = 'block';
      } else {
        chartTooltip.style.display = 'none';
      }
    }
    const tooltipLeft = Math.min(hoverX + 14, chartWidth - 170);
    chartTooltip.style.left = tooltipLeft + 'px';
    chartTooltip.style.top = '6px';
  } else {
    chartTooltip.style.display = 'none';
  }
}

chartCanvas.addEventListener('mousemove', (e) => {
  const rect = chartCanvas.getBoundingClientRect();
  hoverX = (e.clientX - rect.left) * (chartCanvas.width / rect.width);
});
chartCanvas.addEventListener('mouseleave', () => {
  hoverX = null;
  chartTooltip.style.display = 'none';
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportChartAsPng() {
  chartCanvas.toBlob(blob => downloadBlob(blob, `traffic-health-${Math.round(simClock)}s.png`));
}

function exportChartAsCsv() {
  const lines = [];
  const laneCols = Array.from({ length: state.lanes }, (_, i) => `lane_${i + 1}_mph`);
  lines.push(['time_s', ...laneCols].join(','));
  for (const sample of state.laneSpeedHistory) {
    const row = [sample.t.toFixed(2), ...sample.speeds.map(v => (v === null ? '' : v.toFixed(1)))];
    lines.push(row.join(','));
  }
  lines.push('');
  lines.push('event_time_s,type,label,detail');
  for (const ev of state.events) {
    const detail = `"${ev.detail.replace(/"/g, '""')}"`;
    lines.push([ev.t.toFixed(2), ev.type, ev.label, detail].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  downloadBlob(blob, `traffic-health-${Math.round(simClock)}s.csv`);
}

document.getElementById('exportChartPngBtn').addEventListener('click', exportChartAsPng);
document.getElementById('exportChartCsvBtn').addEventListener('click', exportChartAsCsv);

/* ---------- Main loop ---------- */
let lastTime = null;
function loop(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  let dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  dt = Math.min(dt, 0.1); // avoid huge jumps if tab was backgrounded

  if (state.running) {
    step(dt * state.timeScale);
  }
  draw();
  drawChart();
  updateHudAndStats();
  requestAnimationFrame(loop);
}

/* ---------- Wire up UI ---------- */
document.getElementById('applyBtn').addEventListener('click', rebuildRoad);
document.getElementById('resetBtn').addEventListener('click', resetTrafficOnly);

document.getElementById('playPauseBtn').addEventListener('click', (e) => {
  state.running = !state.running;
  e.target.textContent = state.running ? 'Pause' : 'Play';
});

document.getElementById('timeScaleInput').addEventListener('input', (e) => {
  state.timeScale = parseFloat(e.target.value);
  document.getElementById('timeScaleValue').textContent = `${state.timeScale}\u00d7`;
});

document.getElementById('spawnBtn').addEventListener('click', spawnManualCar);

document.getElementById('passingOnlyCheckbox').addEventListener('change', (e) => {
  const was = state.passingOnly;
  state.passingOnly = e.target.checked;
  populateSpawnLaneOptions();
  pushEvent('settings', 'Settings changed', `Passing-only lane ${was ? 'On' : 'Off'}→${state.passingOnly ? 'On' : 'Off'}`);
});

window.addEventListener('resize', () => {
  resizeCanvas();
  resizeChartCanvas();
});

/* ---------- Init ---------- */
rebuildRoad();
requestAnimationFrame(loop);
