package com.rit.bustracker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BusLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}