import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  TouchableOpacity,
  Text,
  Alert,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {
  Card,
  Title,
  Provider as PaperProvider,
  Divider,
} from 'react-native-paper';
import ProfileCard from './ProfileCard';
import {useNavigation} from '@react-navigation/native';
import Toast from 'react-native-root-toast';
import Tts from 'react-native-tts';
import {
  accelerometer,
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import useRampDetection from './rampDetection';
import {
  useStopDetails,
  StopDetailsDisplay,
  AssistanceAlert,
} from './StopDetails';

// ----------------------------------------------------------------
// Global Journey Details – Storing tripId
// ----------------------------------------------------------------
let currentJourneyDetails = {
  tripId: null,
};

// Default details for events
const DEFAULT_EVENT_DETAILS = {
  passengerName: 'Default Passenger',
  userName: 'Default User',
};

// ----------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------
const generateUniqueId = () => '_' + Math.random().toString(36).substr(2, 9);
const getCurrentTimestamp = () => new Date().toISOString();

// ----------------------------------------------------------------
// API Helper Functions
// ----------------------------------------------------------------

const startTrip = async () => {
  try {
    const payload = '{"data":{}, "tripStart":"true"}';
    const response = await fetch(
      'https://bsurhdv6je.execute-api.us-east-1.amazonaws.com/Staging?',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'application/json',
        },
        body: payload,
      },
    );
    const data = await response.json();
    console.log('Response from startTrip:', data);
    if (data && data.tripId) {
      currentJourneyDetails.tripId = data.tripId;
      console.log('Trip started, received tripId:', data.tripId);
    } else {
      console.warn('No tripId returned from startTrip response:', data);
    }
  } catch (error) {
    console.error('Error starting trip:', error);
  }
};

const sendEventData = async eventData => {
  const payloadObject = {
    data: {
      incident: eventData.incident,
      intensity: eventData.intensity,
      passengerName:
        eventData.passengerName || DEFAULT_EVENT_DETAILS.passengerName,
      userName: eventData.userName || DEFAULT_EVENT_DETAILS.userName,
      eventTimeStamp: eventData.eventTimeStamp || getCurrentTimestamp(),
    },
    incident: 'true',
    tripId: currentJourneyDetails.tripId,
  };

  const payload = JSON.stringify(payloadObject);
  console.log('Sending event payload:', payload);
  try {
    const response = await fetch(
      'https://bsurhdv6je.execute-api.us-east-1.amazonaws.com/Staging?',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'application/json',
        },
        body: payload,
      },
    );
    if (!response.ok) {
      console.error('Failed to send event data:', response.statusText);
    } else {
      const result = await response.json();
      console.log('Event data sent successfully:', result);
    }
  } catch (error) {
    console.error('Error sending event data:', error);
  }
};

const endTrip = async journeySummary => {
  try {
    const payloadObject = {
      data: {
        tripSummary: {
          averageSpeed: journeySummary.overview.averageSpeed,
          totalDistance: journeySummary.overview.totalDistance,
          journeyDuration: journeySummary.overview.journeyDuration,
          incident: journeySummary.overview.incident,
          bumpDetails: journeySummary.overview.bumpDetails,
          incidentData: {
            overSpeedDetected:
              journeySummary.overview.incidentData.overSpeedDetected,
            fallsDetected: journeySummary.overview.incidentData.fallsDetected,
            forwardMovementDownTheSlope:
              journeySummary.overview.incidentData.inclineDetected,
          },
          stopDetails: journeySummary.overview.stopDetails,
        },
      },
      tripStart: 'false',
      tripEnd: true,
      tripId: currentJourneyDetails.tripId,
    };
    const payload = JSON.stringify(payloadObject);
    console.log('Sending Journey Summary Payload:', payload);
    const response = await fetch(
      'https://bsurhdv6je.execute-api.us-east-1.amazonaws.com/Staging?',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'application/json',
        },
        body: payload,
      },
    );
    const data = await response.json();
    console.log('Backend response for Trip End:', data);
    if (data.message === 'success') {
      console.log('Journey Summary sent successfully');
    } else {
      console.error('Journey Summary send failed');
    }
    currentJourneyDetails.tripId = data.newTripId || null;
  } catch (error) {
    console.error('Error ending trip:', error);
  }
};

// ----------------------------------------------------------------
// Dynamic Calibration Function
// ----------------------------------------------------------------
const dynamicCalibration = () => {
  return new Promise(resolve => {
    let calibrationReadings = [];
    const calibrationThreshold = 0.1; // Acceptable noise level for Z axis
    const calibrationDuration = 5000; // Fallback timeout in ms
    setUpdateIntervalForType(SensorTypes.accelerometer, 100);

    const subscription = accelerometer.subscribe(({x, y, z}) => {
      calibrationReadings.push(z);
    });

    const checkInterval = setInterval(() => {
      if (calibrationReadings.length > 5) {
        const mean =
          calibrationReadings.reduce((a, b) => a + b, 0) /
          calibrationReadings.length;
        const variance =
          calibrationReadings.reduce((acc, val) => acc + (val - mean) ** 2, 0) /
          calibrationReadings.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev < calibrationThreshold) {
          clearInterval(checkInterval);
          subscription.unsubscribe();
          console.log('Dynamic calibration complete:', {stdDev});
          resolve();
        }
      }
    }, 500);

    setTimeout(() => {
      clearInterval(checkInterval);
      subscription.unsubscribe();
      console.log('Dynamic calibration fallback reached.');
      resolve();
    }, calibrationDuration);
  });
};

// ----------------------------------------------------------------
// Main Tracking Component (Sitting Mode Only)
// ----------------------------------------------------------------
export default function TrackingIOS() {
  const navigation = useNavigation();
  const isIOS = Platform.OS === 'ios';

  // -------------------------------
  // State variables
  // -------------------------------
  const [location, setLocation] = useState(null);
  const [heading, setHeading] = useState(null);
  const [forwardHeading, setForwardHeading] = useState(null);
  const [speed, setSpeed] = useState(0);
  const [tracking, setTracking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [startTime, setStartTime] = useState(null);
  const [distanceTraveled, setDistanceTraveled] = useState(0);
  const [averageSpeed, setAverageSpeed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  // Incident event counters
  const [minorJerkCount, setMinorJerkCount] = useState(0);
  const [majorJerkCount, setMajorJerkCount] = useState(0);
  const [sharpLeftCount, setSharpLeftCount] = useState(0);
  const [sharpRightCount, setSharpRightCount] = useState(0);
  const [bumpMajorCount, setBumpMajorCount] = useState(0);
  const [bumpMinorCount, setBumpMinorCount] = useState(0);
  const [overSpeedCount, setOverSpeedCount] = useState(0);
  const [fallCount, setFallCount] = useState(0);
  const [isFallen, setIsFallen] = useState(false);
  const [crashCount, setCrashCount] = useState(0);
  const [inclineCount, setInclineCount] = useState(0);
  const [rating, setRating] = useState(0);
  const [leftTurnCount, setLeftTurnCount] = useState(0);
  const [rightTurnCount, setRightTurnCount] = useState(0);

  // Constants for alerts and thresholds
  const OVERSPEED_THRESHOLD = 0.9;
  const SPEED_ALERT_COOLDOWN = 3000;
  const NOISE_THRESHOLD = 3.0;
  const BUFFER_SIZE = 5;
  const BUMP_THRESHOLD = 0.15;
  const BUMP_MAJOR_THRESHOLD = 0.4;
  const BUMP_DEBOUNCE_MS = 500;
  const MINOR_JERK_THRESHOLD = 1.0;
  const MAJOR_JERK_THRESHOLD = 1.5;
  const MIN_CRASH_SPEED = 0.2;
  const SPEED_LIMIT = 10;
  const STOP_SPEED_THRESHOLD = 0.2;
  const MIN_TURN_SUPPRESSION_MS = 2000;
  let currentToast = null;

  const accelBufferRef = useRef([]);
  const disableGyroRef = useRef(false);
  const lastBumpTimeRef = useRef(0);
  const locationSubscription = useRef(null);
  const lastLocation = useRef(null);
  const lastLocationTimeRef = useRef(null);
  const speedReadings = useRef([]);
  // Reference to store the previously smoothed speed value.
  const previousSpeedRef = useRef(0);
  const filteredLocation = useRef(null);
  const pLat = useRef(null);
  const pLon = useRef(null);
  const cumulativeDistance = useRef(0);
  const crashCooldownInternalRef = useRef(false);
  const baselineZRef = useRef(null);
  const baselineFallRef = useRef(null);
  const fallDetectionStartRef = useRef(null);

  const {
    timesStopped15Sec,
    stops,
    checkIfStandingStill,
    finalizeStop,
    setTimesStopped15Sec,
    setStops,
  } = useStopDetails();

  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const resultShownRef = useRef(false);
  useEffect(() => {
    resultShownRef.current = showResults;
  }, [showResults]);

  const showToastNotification = (cause, intensityLabel) => {
    if (currentToast !== null) {
      Toast.hide(currentToast);
      currentToast = null;
    }
    const displayText = cause.endsWith('!') ? cause : cause;
    const toastContent = (
      <View style={toastStyles.container}>
        <Text style={toastStyles.causeText}>{displayText}</Text>
        {intensityLabel && (
          <Text style={toastStyles.intensityText}>
            Intensity: {intensityLabel}
          </Text>
        )}
      </View>
    );
    currentToast = Toast.show(toastContent, {
      duration: cause === 'Bump Detected' ? 1000 : 3000,
      position: Toast.positions.TOP,
      shadow: false,
      animation: true,
      hideOnPress: true,
      delay: 0,
      containerStyle: {
        backgroundColor: '#E6E6FA',
        borderColor: '#6200ee',
        borderWidth: 2,
        borderRadius: 14,
        padding: 16,
        elevation: 0,
        shadowColor: 'transparent',
        shadowOpacity: 2,
        shadowOffset: {width: 0, height: 0},
        width: '95%',
        alignSelf: 'center',
      },
    });
  };

  const toastStyles = StyleSheet.create({
    container: {
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      borderRadius: 0,
      paddingVertical: 8,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    causeText: {
      fontSize: 22,
      fontWeight: 'bold',
      color: '#6200ee',
      textAlign: 'center',
    },
    intensityText: {
      fontSize: 18,
      fontWeight: 'bold',
      color: '#d32f2f',
      textAlign: 'center',
    },
  });

  const SummaryItem = ({label, value}) => (
    <View style={summaryStyles.itemContainer}>
      <Text style={summaryStyles.itemLabel}>{label}</Text>
      <Text style={summaryStyles.itemValue}>{value}</Text>
    </View>
  );

  const summaryStyles = StyleSheet.create({
    container: {
      backgroundColor: '#fff',
      borderRadius: 10,
      padding: 20,
      marginVertical: 10,
      elevation: 5,
    },
    header: {
      fontSize: 24,
      fontWeight: '700',
      color: '#6200ee',
      textAlign: 'center',
      marginBottom: 10,
    },
    sectionHeader: {
      fontSize: 20,
      fontWeight: '600',
      color: '#6200ee',
      marginTop: 10,
      marginBottom: 4,
    },
    itemContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginVertical: 6,
    },
    itemLabel: {
      fontSize: 16,
      color: '#333',
    },
    itemValue: {
      fontSize: 16,
      fontWeight: 'bold',
      color: '#915F6D',
    },
    divider: {
      marginVertical: 8,
    },
    stopsHeader: {
      fontSize: 18,
      fontWeight: '600',
      color: '#6200ee',
      marginTop: 10,
      marginBottom: 4,
    },
    stopItem: {
      fontSize: 14,
      color: '#333',
      marginVertical: 2,
    },
    footer: {
      paddingVertical: 10,
      borderTopWidth: 1,
      borderColor: '#ccc',
      marginTop: 10,
      alignItems: 'center',
    },
  });

  const StarRating = ({rating, onRate}) => {
    const stars = [1, 2, 3, 4, 5];
    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          marginVertical: 5,
        }}>
        {stars.map(star => (
          <TouchableOpacity key={star} onPress={() => onRate(star)}>
            <Text
              style={{
                fontSize: 24,
                color: star <= rating ? '#FFD700' : '#ccc',
              }}>
              ★
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  useEffect(() => {
    if (calibrating) {
      setUpdateIntervalForType(SensorTypes.accelerometer, 100);
    }
  }, [calibrating]);

  useEffect(() => {
    Tts.setDefaultLanguage('en-US');
    Tts.setDefaultPitch(1.0);
    if (isIOS) {
      Geolocation.requestAuthorization('whenInUse');
    }
    return () => {
      stopAllSensors();
    };
  }, [isIOS]);

  useEffect(() => {
    const interval = setInterval(() => {
      setDistanceTraveled(cumulativeDistance.current);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let accelSubscription = null;
    if (tracking && !paused) {
      setUpdateIntervalForType(SensorTypes.accelerometer, 50);
      accelSubscription = accelerometer.subscribe(({x, y, z}) => {
        if (resultShownRef.current || pausedRef.current) return;
        accelBufferRef.current.push({x, y, z});
        if (accelBufferRef.current.length > BUFFER_SIZE) {
          accelBufferRef.current.shift();
        }
        const avg = accelBufferRef.current.reduce(
          (acc, reading) => ({
            x: acc.x + reading.x,
            y: acc.y + reading.y,
            z: acc.z + reading.z,
          }),
          {x: 0, y: 0, z: 0},
        );
        avg.x /= accelBufferRef.current.length;
        avg.y /= accelBufferRef.current.length;
        avg.z /= accelBufferRef.current.length;
        const currentZ = avg.z;
        if (baselineZRef.current === null) {
          baselineZRef.current = currentZ;
        } else {
          if (Math.abs(currentZ - baselineZRef.current) < 0.15) {
            baselineZRef.current =
              baselineZRef.current * 0.95 + currentZ * 0.05;
          }
        }
        const adjustedZ = currentZ - baselineZRef.current;
        const now = Date.now();
        if (baselineFallRef.current === null) {
          baselineFallRef.current = {x, y, z};
        }
        const dot =
          x * baselineFallRef.current.x +
          y * baselineFallRef.current.y +
          z * baselineFallRef.current.z;
        const magCurrent = Math.sqrt(x * x + y * y + z * z);
        const magBaseline = Math.sqrt(
          baselineFallRef.current.x ** 2 +
            baselineFallRef.current.y ** 2 +
            baselineFallRef.current.z ** 2,
        );
        const angle =
          (Math.acos(dot / (magCurrent * magBaseline)) * 180) / Math.PI;
        const FALL_ANGLE_THRESHOLD = 45;
        const FALL_DETECTION_DURATION = 500;
        if (!isFallen) {
          if (angle > FALL_ANGLE_THRESHOLD) {
            if (fallDetectionStartRef.current === null) {
              fallDetectionStartRef.current = now;
            } else if (
              now - fallDetectionStartRef.current >=
              FALL_DETECTION_DURATION
            ) {
              showToastNotification('Fall Detected', 'Major');
              sendEventData({incident: 'Fall Detected', intensity: 'Major'});
              setFallCount(prev => prev + 1);
              setIsFallen(true);
              fallDetectionStartRef.current = null;
            }
          } else {
            fallDetectionStartRef.current = null;
          }
        } else if (angle < FALL_ANGLE_THRESHOLD) {
          setIsFallen(false);
          if (currentToast !== null) {
            Toast.hide(currentToast);
            currentToast = null;
          }
        }
        if (
          !isFallen &&
          angle < FALL_ANGLE_THRESHOLD &&
          Math.abs(adjustedZ) > BUMP_THRESHOLD &&
          now - lastBumpTimeRef.current > BUMP_DEBOUNCE_MS
        ) {
          disableGyroRef.current = true;
          lastBumpTimeRef.current = now;
          const isMajorBump = Math.abs(adjustedZ) >= BUMP_MAJOR_THRESHOLD;
          const intensity = isMajorBump ? 'Major' : 'Minor';
          if (isMajorBump) {
            setBumpMajorCount(prev => prev + 1);
          } else {
            setBumpMinorCount(prev => prev + 1);
          }
          showToastNotification('Bump Detected', intensity);
          sendEventData({
            incident: 'Bump Detected',
            intensity,
            magnitude: Math.abs(adjustedZ).toFixed(2),
          });
          console.log(
            `Bump detected: AdjustedZ=${adjustedZ.toFixed(
              2,
            )}, Intensity=${intensity}, Timestamp=${new Date(
              now,
            ).toISOString()}`,
          );
          const suppressionDuration = isMajorBump ? 1000 : 500;
          setTimeout(() => {
            disableGyroRef.current = false;
          }, suppressionDuration);
        }
        checkIfStandingStill({x, y, z});
      });
    }
    return () => {
      if (accelSubscription) accelSubscription.unsubscribe();
    };
  }, [tracking, paused, isFallen, checkIfStandingStill]);

  useEffect(() => {
    let gyroSubscription = null;
    if (tracking && !paused) {
      setUpdateIntervalForType(SensorTypes.gyroscope, 250);
      gyroSubscription = gyroscope.subscribe(({x, y, z}) => {
        if (resultShownRef.current || pausedRef.current) return;
        if (disableGyroRef.current) {
          console.log('Turn detection skipped due to active bump');
          return;
        }
        if (crashCooldownInternalRef.current) return;
        const absX = Math.abs(x);
        const absZ = Math.abs(z);
        if (absX < 0.1 && absZ < 0.1) return;
        const maxVal = Math.max(absX, absZ);
        if (maxVal < MINOR_JERK_THRESHOLD) return;
        const detectedJerkType =
          maxVal >= MAJOR_JERK_THRESHOLD ? 'Major' : 'Minor';
        let turnDirection = '';
        if (absX >= absZ) {
          turnDirection = x > 0 ? 'Left Turn Detected' : 'Right Turn Detected';
        } else {
          turnDirection = z > 0 ? 'Left Turn Detected' : 'Right Turn Detected';
        }
        if (turnDirection.includes('Left')) {
          setLeftTurnCount(prev => prev + 1);
        } else if (turnDirection.includes('Right')) {
          setRightTurnCount(prev => prev + 1);
        }
        if (detectedJerkType === 'Major') {
          if (turnDirection.includes('Left')) {
            setSharpLeftCount(prev => prev + 1);
          } else if (turnDirection.includes('Right')) {
            setSharpRightCount(prev => prev + 1);
          }
        }
        let direction =
          detectedJerkType === 'Major'
            ? `Sharp ${turnDirection}`
            : turnDirection;
        if (detectedJerkType === 'Major') {
          setMajorJerkCount(prev => prev + 1);
        } else {
          setMinorJerkCount(prev => prev + 1);
        }
        showToastNotification(direction, detectedJerkType);
        sendEventData({
          incident: `${direction} Detected`,
          intensity: detectedJerkType,
        });
        console.log(
          `Turn detected: Direction=${direction}, Intensity=${detectedJerkType}`,
        );
        crashCooldownInternalRef.current = true;
        setTimeout(() => {
          crashCooldownInternalRef.current = false;
        }, 1000);
      });
    }
    return () => {
      if (gyroSubscription) gyroSubscription.unsubscribe();
    };
  }, [tracking, paused]);

  const lastSpeedAlertTimeRef = useRef(0);
  useEffect(() => {
    if (tracking && !paused) {
      const now = Date.now();
      // Using only the native GPS speed value.
      const currentSpeedMph = speed * 2.23694;
      console.log(`Speed update: current=${currentSpeedMph.toFixed(2)} mph`);
      if (
        currentSpeedMph >= 2 &&
        now - lastSpeedAlertTimeRef.current > SPEED_ALERT_COOLDOWN
      ) {
        setOverSpeedCount(prev => prev + 1);
        showToastNotification('Over Speed', 'Major');
        sendEventData({incident: 'Over Speed', intensity: 'Major'});
        lastSpeedAlertTimeRef.current = now;
      }
    }
  }, [speed, tracking, paused]);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      const locationGranted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'This app needs access to your location for tracking.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        },
      );
      const bodySensorsGranted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.BODY_SENSORS,
        {
          title: 'Body Sensors Permission',
          message: 'This app needs access to your body sensors for tracking.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        },
      );
      return (
        locationGranted === PermissionsAndroid.RESULTS.GRANTED &&
        bodySensorsGranted === PermissionsAndroid.RESULTS.GRANTED
      );
    }
    return true;
  };

  const startTrackingFunc = async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      Alert.alert(
        'Permissions Required',
        'Location permissions are required for tracking.',
      );
      return;
    }
    Geolocation.getCurrentPosition(
      position => {
        lastLocation.current = position.coords;
        lastLocationTimeRef.current = Date.now();
        if (
          position.coords.heading !== undefined &&
          position.coords.heading !== null
        ) {
          setHeading(position.coords.heading);
          if (!forwardHeading) setForwardHeading(position.coords.heading);
        }
        beginTracking();
      },
      error => {
        console.log('Location Error: ', error);
        Alert.alert(
          'Location Error',
          'Unable to get your current location. Please check your permissions and try again.',
        );
      },
      {enableHighAccuracy: true, timeout: 15000, maximumAge: 10000},
    );
  };

  const beginTracking = () => {
    setTracking(true);
    setPaused(false);
    setStartTime(Date.now());
    speedReadings.current = [];
    cumulativeDistance.current = 0;
    setDistanceTraveled(0);
    lastLocation.current = null;
    lastLocationTimeRef.current = null;
    filteredLocation.current = null;
    pLat.current = null;
    pLon.current = null;
    baselineZRef.current = null;
    previousSpeedRef.current = 0;
    baselineFallRef.current = null;
    // Increase GPS update interval to 500ms.
    locationSubscription.current = Geolocation.watchPosition(
      position => {
        if (resultShownRef.current) return;
        if (!pausedRef.current) {
          const {coords} = position;
          const {latitude: rawLat, longitude: rawLon, accuracy} = coords;
          const now = Date.now();
          if (accuracy && accuracy > 30) return;
          // Grab the raw speed from the GPS.
          let newSpeed = 0;
          if (coords.speed != null && coords.speed >= 0) {
            newSpeed = coords.speed;
          } else {
            newSpeed = 0;
          }
          // --- Updated Speed Filtering Logic ---
          // If the new speed is very low, force 0 immediately.
          if (newSpeed < 0.1) {
            previousSpeedRef.current = 0;
            setSpeed(0);
          } else {
            const diff = Math.abs(newSpeed - previousSpeedRef.current);
            // Determine smoothingFactor based on acceleration vs. deceleration.
            // When decelerating (newSpeed is less than previous), force an immediate update.
            let smoothingFactor = 0.4;
            if (newSpeed < previousSpeedRef.current || diff > 0.3) {
              smoothingFactor = 1;
            }
            const updatedSpeed =
              previousSpeedRef.current * (1 - smoothingFactor) +
              newSpeed * smoothingFactor;
            previousSpeedRef.current = updatedSpeed;
            setSpeed(updatedSpeed);
            speedReadings.current.push(updatedSpeed);
          }
          lastLocationTimeRef.current = now;
          setLocation({latitude: rawLat, longitude: rawLon, timestamp: now});
          if (coords.heading !== undefined && coords.heading !== null) {
            setHeading(coords.heading);
          }
          if (!filteredLocation.current) {
            filteredLocation.current = {latitude: rawLat, longitude: rawLon};
            pLat.current = 1;
            pLon.current = 1;
          } else {
            const R = 0.0001,
              Q = 0.0001;
            const kalmanGainLat = pLat.current / (pLat.current + R);
            const newLat =
              filteredLocation.current.latitude +
              kalmanGainLat * (rawLat - filteredLocation.current.latitude);
            pLat.current = (1 - kalmanGainLat) * pLat.current + Q;
            const kalmanGainLon = pLon.current / (pLon.current + R);
            const newLon =
              filteredLocation.current.longitude +
              kalmanGainLon * (rawLon - filteredLocation.current.longitude);
            pLon.current = (1 - kalmanGainLon) * pLon.current + Q;
            const newFilteredLocation = {latitude: newLat, longitude: newLon};
            const deltaDistance = calculateDistance(
              filteredLocation.current,
              newFilteredLocation,
            );
            filteredLocation.current = newFilteredLocation;
            if (deltaDistance > NOISE_THRESHOLD || newSpeed > 0.2) {
              cumulativeDistance.current += deltaDistance;
            }
          }
          lastLocation.current = {latitude: rawLat, longitude: rawLon};
        }
      },
      error => console.log('Location Error: ', error),
      {
        enableHighAccuracy: true,
        distanceFilter: 0,
        interval: 500,
        fastestInterval: 500,
        forceRequestLocation: true,
        showsBackgroundLocationIndicator: true,
        pausesLocationUpdatesAutomatically: false,
        activityType: 'fitness',
        accuracy: 'bestForNavigation',
        maximumAge: 0,
      },
    );
  };

  const calculateDistance = (coord1, coord2) => {
    const {latitude: lat1, longitude: lon1} = coord1;
    const {latitude: lat2, longitude: lon2} = coord2;
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const stopTracking = async () => {
    setTracking(false);
    if (locationSubscription.current) {
      Geolocation.clearWatch(locationSubscription.current);
      locationSubscription.current = null;
    }
    const updatedStops = await finalizeStop();
    const transformedStops = updatedStops.map((stop, index) => ({
      stopNumber: index + 1,
      duration: stop.duration,
    }));
    const readings = speedReadings.current;
    const avgSpeed =
      readings.length > 0
        ? readings.reduce((a, b) => a + b, 0) / readings.length
        : 0;
    setAverageSpeed(avgSpeed);
    const journeyDuration = startTime ? (Date.now() - startTime) / 1000 : 0;
    setDuration(journeyDuration);
    setShowResults(true);
    const finalDistance = distanceTraveled;
    const journeySummaryDetails = {
      averageSpeed: `${(avgSpeed * 2.23694).toFixed(2)} mph`,
      totalDistance: `${finalDistance.toFixed(2)} m`,
      journeyDuration: `${(journeyDuration / 60).toFixed(2)} min`,
      incident: {
        majorJerks: majorJerkCount + bumpMajorCount,
        minorJerks: minorJerkCount + bumpMinorCount,
      },
      bumpDetails: {
        sharpLeftTurns: sharpLeftCount,
        sharpRightTurns: sharpRightCount,
        bumps: bumpMajorCount + bumpMinorCount,
      },
      incidentData: {
        overSpeedDetected: overSpeedCount,
        fallsDetected: fallCount,
        inclineDetected: inclineCount,
      },
      stopDetails: transformedStops,
    };
    console.log('Journey Summary Details:', journeySummaryDetails);
    await endTrip({overview: journeySummaryDetails});
  };

  const stopAllSensors = () => {
    if (locationSubscription.current) {
      Geolocation.clearWatch(locationSubscription.current);
      locationSubscription.current = null;
    }
  };

  const handleStartButton = async () => {
    setCalibrating(true);
    await dynamicCalibration();
    setCalibrating(false);
    await startTrip();
    Geolocation.getCurrentPosition(
      position => {
        lastLocation.current = position.coords;
        lastLocationTimeRef.current = Date.now();
        startTrackingFunc();
      },
      error => {
        console.error('Error refreshing GPS baseline:', error);
        startTrackingFunc();
      },
      {enableHighAccuracy: true, timeout: 15000, maximumAge: 10000},
    );
  };

  const handleRampDetected = (currentAngle, baselineAngle, angleDifference) => {
    console.log(
      'Ramp detected. Baseline angle:',
      baselineAngle,
      'Current angle:',
      currentAngle,
      'Difference:',
      angleDifference,
    );
    showToastNotification('Moving forward down the slope!', 'Major');
    setInclineCount(prev => prev + 1);
    sendEventData({
      incident: 'Forward movement down the slope',
      intensity: 'Major',
    });
  };
  useRampDetection(tracking, handleRampDetected);

  const finalDistance = distanceTraveled;
  const totalJerks =
    minorJerkCount + majorJerkCount + bumpMajorCount + bumpMinorCount;
  const totalMajorJerks = majorJerkCount + bumpMajorCount;
  const totalMinorJerks = minorJerkCount + bumpMinorCount;
  const totalBumps = bumpMajorCount + bumpMinorCount;

  return (
    <PaperProvider>
      <View style={styles.container}>
        {calibrating && (
          <View style={styles.calibrationOverlay}>
            <View style={styles.calibrationContent}>
              <ActivityIndicator size="large" color="#6200ee" />
              <Text style={styles.calibrationMessage}>
                Please Wait... We are preparing your app.
              </Text>
            </View>
          </View>
        )}
        {!tracking && !showResults && (
          <>
            <ProfileCard />
            <TouchableOpacity style={styles.button} onPress={handleStartButton}>
              <Text style={styles.buttonText}>
                {countdown !== null ? countdown : 'Start Tracking'}
              </Text>
            </TouchableOpacity>
          </>
        )}
        {tracking && (
          <Card style={styles.card}>
            <Card.Content>
              <Title style={styles.title}>Ongoing Trip</Title>
              <Text style={styles.speedLabel}>Speed:</Text>
              <Text style={[styles.speedText, {color: 'green'}]}>
                {(speed * 2.23694).toFixed(2)} mph
              </Text>
              <View style={styles.buttonContainer}>
                <TouchableOpacity
                  style={styles.stopButton}
                  onPress={stopTracking}>
                  <Text style={styles.buttonText}>Stop Journey</Text>
                </TouchableOpacity>
              </View>
            </Card.Content>
          </Card>
        )}
        {showResults && (
          <View style={styles.summaryContainer}>
            <Card style={styles.card}>
              <Card.Content>
                <Text style={summaryStyles.header}>Journey Summary</Text>
                <Divider style={summaryStyles.divider} />
                <ScrollView style={styles.summaryScrollView}>
                  <SummaryItem
                    label="Average Speed"
                    value={`${(averageSpeed * 2.23694).toFixed(2)} mph`}
                  />
                  <SummaryItem
                    label="Total Distance"
                    value={`${finalDistance.toFixed(2)} m`}
                  />
                  <SummaryItem
                    label="Journey Duration"
                    value={`${(duration / 60).toFixed(2)} min`}
                  />
                  <Divider style={summaryStyles.divider} />
                  <Text style={summaryStyles.sectionHeader}>Jerk Details</Text>
                  <SummaryItem label="Total Left Turns" value={leftTurnCount} />
                  <SummaryItem
                    label="Total Right Turns"
                    value={rightTurnCount}
                  />
                  <SummaryItem label="Total Jerks" value={totalJerks} />
                  <SummaryItem label="Major Jerks" value={totalMajorJerks} />
                  <SummaryItem label="Minor Jerks" value={totalMinorJerks} />
                  <Divider style={summaryStyles.divider} />
                  <Text style={summaryStyles.sectionHeader}>
                    Turn & Bump Details
                  </Text>
                  <SummaryItem
                    label="Sharp Left Turns"
                    value={sharpLeftCount}
                  />
                  <SummaryItem
                    label="Sharp Right Turns"
                    value={sharpRightCount}
                  />
                  <SummaryItem label="Bumps" value={totalBumps} />
                  <Divider style={summaryStyles.divider} />
                  <Text style={summaryStyles.sectionHeader}>
                    Fall, Speed, Crash & Slope Movement
                  </Text>
                  <SummaryItem
                    label="Over Speed Detected"
                    value={overSpeedCount}
                  />
                  <SummaryItem label="Falls Detected" value={fallCount} />
                  <SummaryItem
                    label="Forward movement down the slope"
                    value={inclineCount}
                  />
                  <Divider style={summaryStyles.divider} />
                  <StopDetailsDisplay
                    stops={stops}
                    timesStopped15Sec={timesStopped15Sec}
                  />
                </ScrollView>
                <View style={summaryStyles.footer}>
                  <Text style={summaryStyles.sectionHeader}>
                    Rate Your Journey
                  </Text>
                  <StarRating rating={rating} onRate={setRating} />
                  <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => {
                      setTimesStopped15Sec(0);
                      setStops([]);
                      setShowResults(false);
                      cumulativeDistance.current = 0;
                      setDistanceTraveled(0);
                      setSpeed(0);
                      setAverageSpeed(0);
                      setDuration(0);
                      setMinorJerkCount(0);
                      setMajorJerkCount(0);
                      setSharpLeftCount(0);
                      setSharpRightCount(0);
                      setBumpMajorCount(0);
                      setBumpMinorCount(0);
                      setLeftTurnCount(0);
                      setRightTurnCount(0);
                      setInclineCount(0);
                      setRating(0);
                      setIsFallen(false);
                      setOverSpeedCount(0);
                      setFallCount(0);
                      setCrashCount(0);
                      setForwardHeading(null);
                      setHeading(null);
                    }}>
                    <Text style={styles.buttonText}>Back</Text>
                  </TouchableOpacity>
                </View>
              </Card.Content>
            </Card>
          </View>
        )}
      </View>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(230,230,250,0.4)',
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calibrationOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  calibrationContent: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  calibrationMessage: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: 'bold',
    color: '#6200ee',
  },
  card: {
    width: '100%',
    borderRadius: 10,
    elevation: 5,
    backgroundColor: '#ffffff',
    marginVertical: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
  },
  stopButton: {
    backgroundColor: '#D32F2F',
    padding: 12,
    borderRadius: 5,
    marginVertical: 10,
    width: '45%',
    alignItems: 'center',
  },
  backButton: {
    backgroundColor: '#6200ee',
    padding: 12,
    borderRadius: 5,
    width: '60%',
    alignItems: 'center',
    marginTop: 10,
  },
  button: {
    backgroundColor: '#6200ee',
    padding: 12,
    borderRadius: 5,
    marginVertical: 10,
    width: '45%',
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontSize: 14,
    textAlign: 'center',
  },
  speedLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 5,
    color: '#333',
    textAlign: 'center',
  },
  speedText: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 20,
    textAlign: 'center',
  },
  summaryContainer: {
    position: 'absolute',
    left: 20,
    right: 20,
    maxHeight: 700,
  },
  summaryScrollView: {
    maxHeight: 450,
  },
});
