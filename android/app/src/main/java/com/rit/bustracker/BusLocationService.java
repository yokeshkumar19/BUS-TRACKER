package com.rit.bustracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BusLocationService extends Service {

    private static final String TAG = "BusLocationService";

    // ---------------------------------------------------------
    // SUPABASE CONFIG
    // ---------------------------------------------------------
    private static final String SUPABASE_URL =
            "https://ccmdnkwnouxltxmwgqob.supabase.co";

    private static final String SUPABASE_KEY =
            "sb_publishable_fbRjLvgclDyzO5JNb7ohRA_bXywpHyT";

    private static final String SUPABASE_TABLE = "bus_locations";

    // ---------------------------------------------------------
    // NOTIFICATION
    // ---------------------------------------------------------
    private static final String CHANNEL_ID = "bus_location_channel";
    private static final int NOTIFICATION_ID = 4821;

    // ---------------------------------------------------------
    // SHARED PREFERENCES
    // ---------------------------------------------------------
    private static final String PREFS = "BusLocationPrefs";
    private static final String KEY_BUS_ID = "busId";
    private static final String KEY_PROJECT_ID = "projectId";
    private static final String KEY_API_KEY = "apiKey";
    private static final String KEY_COLLECTION = "collection";

    // ---------------------------------------------------------
    // JAVASCRIPT LISTENER
    // ---------------------------------------------------------
    public interface Listener {
        void onLocation(JSONObject data);
    }

    public static volatile Listener listener;

    // ---------------------------------------------------------
    // LOCATION
    // ---------------------------------------------------------
    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private HandlerThread locationThread;

    // ---------------------------------------------------------
    // WAKE LOCK
    // ---------------------------------------------------------
    private PowerManager.WakeLock wakeLock;

    // ---------------------------------------------------------
    // UPLOAD THREAD
    // ---------------------------------------------------------
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();

    private String busId;
    private String projectId;
    private String apiKey;
    private String collection;


    // =========================================================
    // SERVICE CREATED
    // =========================================================
    @Override
    public void onCreate() {
        super.onCreate();

        Log.d(TAG, "========== SERVICE CREATED ==========");

        fusedClient = LocationServices.getFusedLocationProviderClient(this);

        createNotificationChannel();

        locationThread = new HandlerThread("BusLocationThread");
        locationThread.start();

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "BusLocationService::TrackingWakeLock"
            );
            try {
                wakeLock.acquire(10 * 60 * 60 * 1000L);
                Log.d(TAG, "WakeLock acquired");
            } catch (Exception e) {
                Log.e(TAG, "WakeLock error", e);
            }
        }

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        busId = prefs.getString(KEY_BUS_ID, null);
        projectId = prefs.getString(KEY_PROJECT_ID, null);
        apiKey = prefs.getString(KEY_API_KEY, null);
        collection = prefs.getString(KEY_COLLECTION, "buses");

        Log.d(TAG, "Saved busId = " + busId);
    }


    // =========================================================
    // SERVICE STARTED
    // =========================================================
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {

        Log.d(TAG, "========== SERVICE START COMMAND ==========");

        if (intent != null) {
            String newBusId = intent.getStringExtra("busId");
            String newProjectId = intent.getStringExtra("projectId");
            String newApiKey = intent.getStringExtra("apiKey");
            String newCollection = intent.getStringExtra("collection");

            if (newBusId != null && !newBusId.trim().isEmpty()) busId = newBusId;
            if (newProjectId != null && !newProjectId.trim().isEmpty()) projectId = newProjectId;
            if (newApiKey != null && !newApiKey.trim().isEmpty()) apiKey = newApiKey;
            if (newCollection != null && !newCollection.trim().isEmpty()) collection = newCollection;

            SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            if (busId != null) editor.putString(KEY_BUS_ID, busId);
            if (projectId != null) editor.putString(KEY_PROJECT_ID, projectId);
            if (apiKey != null) editor.putString(KEY_API_KEY, apiKey);
            if (collection != null) editor.putString(KEY_COLLECTION, collection);
            editor.apply();
        }

        if (busId == null || busId.trim().isEmpty()) {
            busId = "default_bus";
        }

        Log.d(TAG, "Starting foreground notification...");
        startForegroundCompat();

        Log.d(TAG, "Starting GPS updates...");
        startLocationUpdates();

        Log.d(TAG, "Service started. busId = " + busId);

        return START_STICKY;
    }


    // =========================================================
    // FOREGROUND START (Android 10+ requires FOREGROUND_SERVICE_TYPE)
    // =========================================================
    private void startForegroundCompat() {
        Notification notification = buildNotification();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            Log.d(TAG, "Foreground service started successfully");

        } catch (Exception e) {
            Log.e(TAG, "FAILED TO START FOREGROUND SERVICE", e);
            stopSelf();
        }
    }


    // =========================================================
    // LOCATION UPDATES
    // =========================================================
    private void startLocationUpdates() {

        if (locationCallback != null) {
            Log.d(TAG, "Location updates already running");
            return;
        }

        LocationRequest request = new LocationRequest.Builder(
                Priority.PRIORITY_HIGH_ACCURACY,
                3000
        )
                .setMinUpdateIntervalMillis(2000)
                .setMinUpdateDistanceMeters(0f)
                .build();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location loc = result.getLastLocation();
                if (loc != null) {
                    handleLocation(loc);
                } else {
                    Log.w(TAG, "LocationResult received but location is null");
                }
            }
        };

        try {
            fusedClient.requestLocationUpdates(
                    request,
                    locationCallback,
                    locationThread.getLooper()
            );
            Log.d(TAG, "GPS LOCATION UPDATES REQUESTED SUCCESSFULLY");

        } catch (SecurityException e) {
            Log.e(TAG, "LOCATION PERMISSION MISSING OR DENIED", e);
            stopSelf();

        } catch (Exception e) {
            Log.e(TAG, "FAILED TO REQUEST LOCATION UPDATES", e);
            stopSelf();
        }
    }


    // =========================================================
    // HANDLE LOCATION
    // =========================================================
    private void handleLocation(Location loc) {

        double latitude = loc.getLatitude();
        double longitude = loc.getLongitude();
        float accuracy = loc.getAccuracy();

        Log.d(TAG, "================================");
        Log.d(TAG, "GPS LOCATION RECEIVED");
        Log.d(TAG, "Bus ID: " + busId);
        Log.d(TAG, "Latitude: " + latitude);
        Log.d(TAG, "Longitude: " + longitude);
        Log.d(TAG, "Accuracy: " + accuracy);
        Log.d(TAG, "================================");

        Listener l = listener;
        if (l != null) {
            try {
                JSONObject data = new JSONObject();
                data.put("latitude", latitude);
                data.put("longitude", longitude);
                data.put("accuracy", accuracy);
                data.put("time", loc.getTime());
                l.onLocation(data);
            } catch (Exception e) {
                Log.e(TAG, "JavaScript listener error", e);
            }
        }

        uploadExecutor.execute(() -> uploadToSupabase(latitude, longitude, accuracy));
    }


    // =========================================================
    // SUPABASE UPLOAD
    // =========================================================
    @SuppressWarnings("ConstantConditions")
    private void uploadToSupabase(double lat, double lng, double accuracy) {

        if (busId == null || busId.trim().isEmpty()) {
            Log.e(TAG, "SUPABASE UPLOAD STOPPED: busId is missing");
            return;
        }

        if (SUPABASE_KEY.trim().isEmpty()
                || SUPABASE_KEY.equals("YOUR_SUPABASE_PUBLISHABLE_KEY")) {
            Log.e(TAG, "SUPABASE PUBLISHABLE KEY IS MISSING");
            return;
        }

        try {
            String urlStr = SUPABASE_URL
                    + "/rest/v1/"
                    + SUPABASE_TABLE
                    + "?on_conflict=bus_id";

            JSONObject body = new JSONObject();
            body.put("bus_id", busId);
            body.put("lat", lat);
            body.put("lng", lng);
            body.put("accuracy", accuracy);
            body.put("updated_at", getUtcTimestamp());
            body.put("live", true);

            Log.d(TAG, "Uploading GPS location to Supabase...");

            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            try {
                conn.setRequestMethod("POST");
                conn.setRequestProperty("apikey", SUPABASE_KEY);
                conn.setRequestProperty("Authorization", "Bearer " + SUPABASE_KEY);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Prefer", "resolution=merge-duplicates,return=minimal");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }

                int responseCode = conn.getResponseCode();

                if (responseCode >= 200 && responseCode < 300) {
                    Log.d(TAG, "SUPABASE LOCATION UPDATED: " + lat + ", " + lng + " HTTP=" + responseCode);
                } else {
                    String errorBody = readErrorStream(conn);
                    Log.e(TAG, "SUPABASE UPLOAD FAILED. HTTP=" + responseCode + " BODY=" + errorBody);
                }
            } finally {
                conn.disconnect();
            }

        } catch (Exception e) {
            Log.e(TAG, "SUPABASE UPLOAD EXCEPTION", e);
        }
    }


    private String readErrorStream(HttpURLConnection conn) {
        try {
            InputStream stream = conn.getErrorStream();
            if (stream == null) return "No error response body";

            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                StringBuilder result = new StringBuilder();
                reader.lines().forEach(result::append);
                return result.toString();
            }

        } catch (Exception e) {
            return "Unable to read error response: " + e.getMessage();
        }
    }


    private String getUtcTimestamp() {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date());
    }


    // =========================================================
    // NOTIFICATION CHANNEL
    // =========================================================
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Bus location tracking",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Shows when bus location tracking is active");

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }


    // =========================================================
    // FOREGROUND NOTIFICATION
    // =========================================================
    private Notification buildNotification() {
        int icon = getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.ic_menu_mylocation;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("RIT BusTrack")
                .setContentText("Bus location tracking is active")
                .setSmallIcon(icon)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_SERVICE);

        Intent tapIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (tapIntent != null) {
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    0,
                    tapIntent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );
            builder.setContentIntent(pendingIntent);
        }

        return builder.build();
    }


    // =========================================================
    // SERVICE DESTROYED
    // =========================================================
    @Override
    public void onDestroy() {
        Log.d(TAG, "========== SERVICE DESTROYED ==========");

        if (locationCallback != null) {
            try {
                fusedClient.removeLocationUpdates(locationCallback);
            } catch (Exception e) {
                Log.e(TAG, "Error stopping GPS", e);
            }
            locationCallback = null;
        }

        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception e) {
                Log.e(TAG, "Error releasing WakeLock", e);
            }
        }

        if (locationThread != null) {
            try {
                locationThread.quitSafely();
            } catch (Exception e) {
                Log.e(TAG, "Error stopping location thread", e);
            }
            locationThread = null;
        }

        uploadExecutor.shutdown();

       Log.d(TAG, "BusLocationService stopped");

// Mark bus offline in Supabase
if (busId != null && !busId.isEmpty()) {
    markBusOffline(busId);
}

super.onDestroy();
    }
    private void markBusOffline(String id) {
    try {
        String urlStr = SUPABASE_URL
                + "/rest/v1/"
                + SUPABASE_TABLE
                + "?bus_id=eq." + id;

        JSONObject body = new JSONObject();
        body.put("live", false);
        body.put("updated_at", getUtcTimestamp());

        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("PATCH");
        conn.setRequestProperty("apikey", SUPABASE_KEY);
        conn.setRequestProperty("Authorization", "Bearer " + SUPABASE_KEY);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);

        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        Log.d(TAG, "Marked bus offline in Supabase. HTTP=" + code);
        conn.disconnect();

    } catch (Exception e) {
        Log.e(TAG, "Failed to mark bus offline", e);
    }
}


    // =========================================================
    // BIND
    // =========================================================
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
