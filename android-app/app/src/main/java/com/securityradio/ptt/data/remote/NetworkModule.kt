package com.securityradio.ptt.data.remote

import com.securityradio.ptt.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object NetworkModule {

    private fun buildRetrofit(
        baseUrl: String,
        authTokenProvider: () -> String,
        apiKeyProvider: () -> String,
        onUnauthorized: () -> Unit,
    ): Retrofit {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        val authInterceptor = Interceptor { chain ->
            val token = authTokenProvider().trim()
            val apiKey = apiKeyProvider().trim()
            val builder = chain.request().newBuilder()
            if (token.isNotBlank()) {
                builder.header("Authorization", "Bearer $token")
            } else if (apiKey.isNotBlank()) {
                builder.header("X-Radio-Key", apiKey)
            }
            chain.proceed(builder.build())
        }

        // A 401 on a request that carried a bearer token means the saved
        // session is no longer accepted by the server — surface it so the UI
        // can sign out, instead of failing silently on every screen.
        val unauthorizedInterceptor = Interceptor { chain ->
            val response = chain.proceed(chain.request())
            if (response.code == 401 && chain.request().header("Authorization") != null) {
                onUnauthorized()
            }
            response
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .addInterceptor(authInterceptor)
            .addInterceptor(unauthorizedInterceptor)
            .addInterceptor(logging)
            .build()

        return Retrofit.Builder()
            .baseUrl(normalizeApiBaseUrl(baseUrl))
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    fun channelsApi(
        baseUrl: String,
        authTokenProvider: () -> String,
        apiKeyProvider: () -> String,
        onUnauthorized: () -> Unit = {},
    ): ChannelsApi = buildRetrofit(baseUrl, authTokenProvider, apiKeyProvider, onUnauthorized)
        .create(ChannelsApi::class.java)

    fun radioApi(
        baseUrl: String,
        authTokenProvider: () -> String,
        apiKeyProvider: () -> String,
        onUnauthorized: () -> Unit = {},
    ): RadioApi = buildRetrofit(baseUrl, authTokenProvider, apiKeyProvider, onUnauthorized)
        .create(RadioApi::class.java)

    fun authApi(baseUrl: String): AuthApi =
        buildRetrofit(baseUrl, authTokenProvider = { "" }, apiKeyProvider = { "" }, onUnauthorized = {})
            .create(AuthApi::class.java)
}
