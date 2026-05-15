package com.securityradio.ptt

import android.app.Application
import com.securityradio.ptt.di.RadioAppGraph

class RadioApplication : Application() {

    lateinit var graph: RadioAppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = RadioAppGraph(this)
    }
}
