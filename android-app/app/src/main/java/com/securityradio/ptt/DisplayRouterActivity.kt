package com.securityradio.ptt

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * MAIN/LAUNCHER entry: routes [MainActivity] to the physical built-in display on MP22-style
 * firmware (virtual Display 0 + physical Display 1). Normal devices launch unchanged.
 */
class DisplayRouterActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(DisplayRouter.TAG, "DisplayRouterActivity onCreate — routing to MainActivity.")
        DisplayRouter.startMainActivity(this)
        finish()
    }
}
