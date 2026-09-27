package com.rit.bustracker;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BusLocation",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        ),
        @Permission(
            alias = "notifications",
            strings = {
                Manifest.permission.POST_NOTIFICATIONS
            }
        )
    }
)
public class BusLocationPlugin extends Plugin {

    private static final String TAG = "BusLocationPlugin";

    @PluginMethod
    public void start(PluginCall call) {

        Log.d(TAG, "================================");
        Log.d(TAG, "BusLocation.start() called");

        PermissionState permissionState = getPermissionState("location");

        Log.d(TAG, "Location permission: " + permissionState);

        if (permissionState != PermissionState.GRANTED) {
            Log.d(TAG, "Requesting location permission...");
            requestPermissionForAlias(
                    "location",
                    call,
                    "locationPermissionCallback"
            );
            return;
        }

        checkNotificationPermissionAndStart(call);
    }

    @PermissionCallback
    @SuppressWarnings("unused")
    public void locationPermissionCallback(PluginCall call) {

        Log.d(TAG, "Location permission callback");

        if (getPermissionState("location") == PermissionState.GRANTED) {
            Log.d(TAG, "Location permission GRANTED");
            checkNotificationPermissionAndStart(call);
        } else {
            Log.e(TAG, "Location permission DENIED");
            call.reject("Location permission denied");
        }
    }

    private void checkNotificationPermissionAndStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState notificationState = getPermissionState("notifications");
            Log.d(TAG, "Notification permission: " + notificationState);

            if (notificationState != PermissionState.GRANTED) {
                Log.d(TAG, "Requesting notification permission...");
                requestPermissionForAlias(
                        "notifications",
                        call,
                        "notificationPermissionCallback"
                );
                return;
            }
        }

        startTracking(call);
    }

    @PermissionCallback
    @SuppressWarnings("unused")
    public void notificationPermissionCallback(PluginCall call) {

        Log.d(TAG, "Notification permission callback");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getPermissionState("notifications") != PermissionState.GRANTED) {
                Log.w(TAG, "Notification permission DENIED");
            } else {
                Log.d(TAG, "Notification permission GRANTED");
            }
        }

        startTracking(call);
    }

    private void startTracking(PluginCall call) {

        Log.d(TAG, "Starting BusLocationService...");

        String rawBusId = call.getString("busId");
        String busId = (rawBusId != null && !rawBusId.trim().isEmpty()) ? rawBusId : "default_bus";
        String projectId = call.getString("projectId", "default_project");
        String apiKey = call.getString("apiKey", "default_key");
        String collection = call.getString("collection", "buses");

        Log.d(TAG, "busId = " + busId);
        Log.d(TAG, "projectId = " + projectId);
        Log.d(TAG, "collection = " + collection);

        Context ctx = getContext();

        Intent intent = new Intent(
                ctx,
                BusLocationService.class
        );

        intent.putExtra("busId", busId);
        intent.putExtra("projectId", projectId);
        intent.putExtra("apiKey", apiKey);
        intent.putExtra("collection", collection);

        BusLocationService.listener = data -> {

            JSObject ret = new JSObject();

            ret.put("latitude", data.optDouble("latitude"));
            ret.put("longitude", data.optDouble("longitude"));
            ret.put("accuracy", data.optDouble("accuracy"));
            ret.put("time", data.optLong("time"));

            notifyListeners("location", ret);
        };

        try {

            Log.d(TAG, "Calling startForegroundService()");

            ContextCompat.startForegroundService(
                    ctx,
                    intent
            );

            Log.d(TAG, "startForegroundService() called successfully");

            call.resolve();

        } catch (Exception e) {

            Log.e(
                    TAG,
                    "FAILED TO START BusLocationService",
                    e
            );

            call.reject(
                    "Failed to start location service: "
                            + e.getMessage()
            );
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {

        Log.d(TAG, "Stopping BusLocationService...");

        Context ctx = getContext();

        BusLocationService.listener = null;

        ctx.stopService(
                new Intent(
                        ctx,
                        BusLocationService.class
                )
        );

        Log.d(TAG, "BusLocationService stop requested");

        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {

        Log.d(TAG, "BusLocationPlugin destroyed");

        BusLocationService.listener = null;

        super.handleOnDestroy();
    }
}