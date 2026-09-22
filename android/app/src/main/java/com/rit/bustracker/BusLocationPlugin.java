package com.rit.bustracker; // <-- must match the package line in your MainActivity.java

import android.Manifest;
import android.content.Context;
import android.content.Intent;



import com.getcapacitor.PermissionState;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS bridge: BusLocation.start({ busId, projectId, apiKey, collection })
 *            BusLocation.stop()
 *            BusLocation.addListener("location", cb)   (only fires while the WebView is alive)
 */
@CapacitorPlugin(
    name = "BusLocation",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        )
    }
)
public class   BusLocationPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
            return;
        }
        startTracking(call);
    }

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            startTracking(call);
        } else {
            call.reject("Location permission denied");
        }
    }

    private void startTracking(PluginCall call) {
        String busId = call.getString("busId");
        String projectId = call.getString("projectId");
        String apiKey = call.getString("apiKey");
        String collection = call.getString("collection", "buses");

        if (busId == null || busId.isEmpty() || projectId == null || projectId.isEmpty()
                || apiKey == null || apiKey.isEmpty()) {
            call.reject("busId, projectId and apiKey are required");
            return;
        }

        Context ctx = getContext();
        Intent intent = new Intent(ctx, BusLocationService.class);
        intent.putExtra("busId", busId);
        intent.putExtra("projectId", projectId);
        intent.putExtra("apiKey", apiKey);
        intent.putExtra("collection", collection);

        // Lets the UI follow along while the app is open.
        BusLocationService.listener = data -> {
            JSObject ret = new JSObject();
            ret.put("latitude", data.optDouble("latitude"));
            ret.put("longitude", data.optDouble("longitude"));
            ret.put("accuracy", data.optDouble("accuracy"));
            ret.put("time", data.optLong("time"));
            notifyListeners("location", ret);
        };
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        BusLocationService.listener = null;
        ctx.stopService(new Intent(ctx, BusLocationService.class));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Activity is gone; the service keeps uploading, it just stops talking to the UI.
        BusLocationService.listener = null;
        super.handleOnDestroy();
    }
}