package com.securityradio.ptt.data.remote

import com.securityradio.ptt.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object NetworkModule {

    private fun buildRetrofit(baseUrl: String, apiKey: String): Retrofit {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        val apiKeyInterceptor = Interceptor { chain ->
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

    fun channelsApi(baseUrl: String, apiKey: String): ChannelsApi =
        buildRetrofit(baseUrl, apiKey).create(ChannelsApi::class.java)

    fun radioApi(baseUrl: String, apiKey: String): RadioApi =
        buildRetrofit(baseUrl, apiKey).create(RadioApi::class.java)
}
