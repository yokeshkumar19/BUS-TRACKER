package com.rit.bustracker; // <-- must match the package in your MainActivity.java

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
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

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs as a foreground service so Android keeps it alive with the screen locked.
 * Every GPS fix is (a) sent to a JS listener if the app is open, and
 * (b) PATCHed straight to Firestore over HTTPS, bypassing the WebView entirely.
 */
public class BusLocationService extends Service {

    private static final String TAG = "BusLocationService";
    private static final String CHANNEL_ID = "bus_location_channel";
    private static final int NOTIFICATION_ID = 4821;

    /** Set by BusLocationPlugin while the app is open; null otherwise. Never required for uploads. */
    public interface Listener { void onLocation(JSONObject data); }
    public static volatile Listener listener;

    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();

    private String busId, projectId, apiKey, collection;

    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            busId = intent.getStringExtra("busId");
            projectId = intent.getStringExtra("projectId");
            apiKey = intent.getStringExtra("apiKey");
            collection = intent.getStringExtra("collection");
            if (collection == null) collection = "buses";
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        startLocationUpdates();
        return START_STICKY;
    }

    private void startLocationUpdates() {
        if (locationCallback != null) return; // already running

        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 4000)
                .setMinUpdateIntervalMillis(2000)
                .setMinUpdateDistanceMeters(5f)
                .build();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location loc = result.getLastLocation();
                if (loc != null) handleLocation(loc);
            }
        };

        try {
            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.e(TAG, "Missing location permission", e);
            stopSelf();
        }
    }

    private void handleLocation(Location loc) {
        // Notify the JS side if it's listening (nice-to-have; UI only).
        Listener l = listener;
        if (l != null) {
            try {
                JSONObject data = new JSONObject();
                data.put("latitude", loc.getLatitude());
                data.put("longitude", loc.getLongitude());
                data.put("accuracy", loc.getAccuracy());
                data.put("time", loc.getTime());
                l.onLocation(data);
            } catch (Exception ignored) { }
        }

        // Always upload, regardless of whether the WebView is alive.
        uploadExecutor.execute(() -> uploadToFirestore(loc.getLatitude(), loc.getLongitude()));
    }

    private void uploadToFirestore(double lat, double lng) {
        if (busId == null || projectId == null || apiKey == null) return;

        String urlStr = "https://firestore.googleapis.com/v1/projects/" + projectId
                + "/databases/(default)/documents/" + collection + "/" + busId
                + "?updateMask.fieldPaths=lat&updateMask.fieldPaths=lng"
                + "&updateMask.fieldPaths=live&updateMask.fieldPaths=updatedAt"
                + "&key=" + apiKey;

        try {
            JSONObject fields = new JSONObject();
            fields.put("lat", new JSONObject().put("doubleValue", lat));
            fields.put("lng", new JSONObject().put("doubleValue", lng));
            fields.put("live", new JSONObject().put("booleanValue", true));
            fields.put("updatedAt", new JSONObject().put("timestampValue",
                    new java.text.SimpleDateFormat(
                            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                            java.util.Locale.US
                    ).format(new java.util.Date())));
            JSONObject body = new JSONObject().put("fields", fields);

            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("PATCH");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.e(TAG, "Firestore upload failed, HTTP " + code);
            }
            conn.disconnect();
        } catch (Exception e) {
            Log.e(TAG, "Firestore upload error", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Bus location tracking", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows when your trip location is being shared");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent tapIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, tapIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("RIT BusTrack")
                .setContentText("Bus location tracking is active")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentIntent(pending)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    @Override
    public void onDestroy() {
        if (locationCallback != null) fusedClient.removeLocationUpdates(locationCallback);
        uploadExecutor.shutdown();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}