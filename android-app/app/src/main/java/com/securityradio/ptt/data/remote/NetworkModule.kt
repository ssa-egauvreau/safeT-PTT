package com.securityradio.ptt.data.remote

import com.securityradio.ptt.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object NetworkModule {

    private fun buildRetrofit(baseUrl: String, apiKeyProvider: () -> String): Retrofit {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        // The key is resolved per request so an on-device agency key change
        // takes effect immediately, without rebuilding or restarting the app.
        val apiKeyInterceptor = Interceptor { chain ->
            val apiKey = apiKeyProvider().trim()
            val request = if (apiKey.isNotBlank()) {
                chain.request().newBuilder().header("X-Radio-Key", apiKey).build()
            } else {
                chain.request()
            }
            chain.proceed(request)
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .addInterceptor(apiKeyInterceptor)
            .addInterceptor(logging)
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    fun channelsApi(baseUrl: String, apiKeyProvider: () -> String): ChannelsApi =
        buildRetrofit(baseUrl, apiKeyProvider).create(ChannelsApi::class.java)

    fun radioApi(baseUrl: String, apiKeyProvider: () -> String): RadioApi =
        buildRetrofit(baseUrl, apiKeyProvider).create(RadioApi::class.java)
}
