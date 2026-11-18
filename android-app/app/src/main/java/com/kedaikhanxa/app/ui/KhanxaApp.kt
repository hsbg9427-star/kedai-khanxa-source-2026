package com.kedaikhanxa.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.kedaikhanxa.app.data.AuthRepository
import com.kedaikhanxa.app.data.KhanxaRepository
import com.kedaikhanxa.app.model.Account
import com.kedaikhanxa.app.model.CashierClosing
import com.kedaikhanxa.app.model.Customer
import com.kedaikhanxa.app.model.MiniAtmTransaction
import com.kedaikhanxa.app.model.PpobTransaction
import com.kedaikhanxa.app.model.Product
import com.kedaikhanxa.app.model.Receivable
import com.kedaikhanxa.app.model.Sale
import com.kedaikhanxa.app.model.StoreSetting
import com.kedaikhanxa.app.model.UserProfile
import com.kedaikhanxa.app.ui.screens.ClosingKasirScreen
import com.kedaikhanxa.app.ui.screens.CustomersScreen
import com.kedaikhanxa.app.ui.screens.DashboardScreen
import com.kedaikhanxa.app.ui.screens.LoginScreen
import com.kedaikhanxa.app.ui.screens.MiniAtmScreen
import com.kedaikhanxa.app.ui.screens.PendingActivationScreen
import com.kedaikhanxa.app.ui.screens.PosScreen
import com.kedaikhanxa.app.ui.screens.PpobScreen
import com.kedaikhanxa.app.utils.ClosingMath
import com.kedaikhanxa.app.utils.Formatters
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KhanxaApp() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val authRepo = remember { AuthRepository() }
    val repo = remember { KhanxaRepository() }

    var firebaseUser by remember { mutableStateOf(authRepo.currentUser()) }
    var profile by remember { mutableStateOf<UserProfile?>(null) }
    var loadingProfile by remember { mutableStateOf(firebaseUser != null) }
    var loginBusy by remember { mutableStateOf(false) }
    var loginError by remember { mutableStateOf<String?>(null) }

    DisposableEffect(firebaseUser?.uid) {
        val uid = firebaseUser?.uid
        if (uid == null) {
            profile = null
            loadingProfile = false
            onDispose { }
        } else {
            loadingProfile = true
            val reg = authRepo.observeProfile(
                uid = uid,
                onUpdate = { p ->
                    profile = p
                    loadingProfile = false
                },
                onError = {
                    loadingProfile = false
                }
            )
            onDispose { reg.remove() }
        }
    }

    if (firebaseUser == null) {
        LoginScreen(
            busy = loginBusy,
            errorMessage = loginError,
            onGoogleSignIn = {
                scope.launch {
                    loginBusy = true
                    loginError = null
                    authRepo.signInWithGoogle(context)
                        .onSuccess { u -> firebaseUser = u }
                        .onFailure { err -> loginError = err.message ?: "Login Google gagal." }
                    loginBusy = false
                }
            }
        )
        return
    }

    if (loadingProfile) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val isAdmin = profile?.role == "admin" && profile?.status == "active"
    val isKasir = profile?.role == "kasir" && profile?.status == "active"
    if (!isAdmin && !isKasir) {
        PendingActivationScreen(
            profile = profile,
            onSignOut = {
                authRepo.signOut()
                firebaseUser = null
            }
        )
        return
    }

    val uid = firebaseUser!!.uid
    val displayName = profile?.displayName ?: firebaseUser?.displayName ?: "Petugas"

    var storeSetting by remember { mutableStateOf(StoreSetting()) }
    var accounts by remember { mutableStateOf<List<Account>>(emptyList()) }
    var products by remember { mutableStateOf<List<Product>>(emptyList()) }
    var customers by remember { mutableStateOf<List<Customer>>(emptyList()) }
    var sales by remember { mutableStateOf<List<Sale>>(emptyList()) }
    var miniAtm by remember { mutableStateOf<List<MiniAtmTransaction>>(emptyList()) }
    var ppob by remember { mutableStateOf<List<PpobTransaction>>(emptyList()) }
    var receivables by remember { mutableStateOf<List<Receivable>>(emptyList()) }
    var closings by remember { mutableStateOf<List<CashierClosing>>(emptyList()) }

    DisposableEffect(uid, isAdmin) {
        val regs = listOf(
            repo.observeStoreSettings { storeSetting = it },
            repo.observeAccounts { accounts = it },
            repo.observeProducts { products = it },
            repo.observeCustomers { customers = it },
            repo.observeSales(isAdmin, uid) { sales = it },
            repo.observeMiniAtm(isAdmin, uid) { miniAtm = it },
            repo.observePpob(isAdmin, uid) { ppob = it },
            repo.observeReceivables(isAdmin, uid) { receivables = it },
            repo.observeCashierClosings(isAdmin, uid) { closings = it }
        )
        onDispose { regs.forEach { it.remove() } }
    }

    var currentTab by remember { mutableStateOf("dashboard") }
    LaunchedEffect(isAdmin) {
        // RBAC Guard: pastikan Kasir tidak bisa berada di rute non-operasional
        val allowed = setOf("dashboard", "pos", "mini_atm", "ppob", "customers", "closing")
        if (!isAdmin && currentTab !in allowed) {
            currentTab = "dashboard"
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    val roleTag = if (isAdmin) "Admin" else "Kasir"
                    Text("${storeSetting.storeName} · $roleTag")
                },
                actions = {
                    IconButton(onClick = {
                        authRepo.signOut()
                        firebaseUser = null
                    }) {
                        Icon(Icons.Default.Logout, contentDescription = "Keluar")
                    }
                }
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = currentTab == "dashboard",
                    onClick = { currentTab = "dashboard" },
                    icon = { Icon(Icons.Default.Dashboard, contentDescription = null) },
                    label = { Text("Beranda") }
                )
                NavigationBarItem(
                    selected = currentTab == "pos",
                    onClick = { currentTab = "pos" },
                    icon = { Icon(Icons.Default.PointOfSale, contentDescription = null) },
                    label = { Text("POS") }
                )
                NavigationBarItem(
                    selected = currentTab == "mini_atm",
                    onClick = { currentTab = "mini_atm" },
                    icon = { Icon(Icons.Default.AccountBalance, contentDescription = null) },
                    label = { Text("ATM") }
                )
                NavigationBarItem(
                    selected = currentTab == "ppob",
                    onClick = { currentTab = "ppob" },
                    icon = { Icon(Icons.Default.PhoneAndroid, contentDescription = null) },
                    label = { Text("PPOB") }
                )
                NavigationBarItem(
                    selected = currentTab == "customers",
                    onClick = { currentTab = "customers" },
                    icon = { Icon(Icons.Default.People, contentDescription = null) },
                    label = { Text("Plg") }
                )
                NavigationBarItem(
                    selected = currentTab == "closing",
                    onClick = { currentTab = "closing" },
                    icon = { Icon(Icons.Default.ReceiptLong, contentDescription = null) },
                    label = { Text("Closing") }
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (currentTab) {
                "dashboard" -> DashboardScreen(
                    isAdmin = isAdmin,
                    displayName = displayName,
                    accounts = accounts,
                    sales = sales,
                    closings = closings,
                    onNavigateTab = { currentTab = it }
                )
                "pos" -> PosScreen(
                    isAdmin = isAdmin,
                    products = products,
                    accounts = accounts,
                    customers = customers,
                    storeSetting = storeSetting,
                    onSubmitSale = { cart, disc, method, paid, acc, cust ->
                        repo.submitPosSale(cart, disc, method, paid, acc, cust, uid, displayName)
                    }
                )
                "mini_atm" -> MiniAtmScreen(
                    isAdmin = isAdmin,
                    accounts = accounts,
                    transactions = miniAtm,
                    onSubmitMiniAtm = { sType, bank, cust, targetNo, principal, adminFee, bankFee, cashAcc, bankAcc ->
                        repo.submitMiniAtm(sType, bank, cust, targetNo, principal, adminFee, bankFee, cashAcc, bankAcc, uid, displayName)
                    }
                )
                "ppob" -> PpobScreen(
                    isAdmin = isAdmin,
                    accounts = accounts,
                    transactions = ppob,
                    onSubmitPpob = { cat, prov, targetNo, cap, sell, adm, depAcc, cashAcc ->
                        repo.submitPpob(cat, prov, targetNo, cap, sell, adm, depAcc, cashAcc, uid, displayName)
                    }
                )
                "customers" -> CustomersScreen(
                    customers = customers,
                    accounts = accounts,
                    onCreateCustomer = { n, p, a, notes -> repo.createCustomer(n, p, a, notes, uid) },
                    onUpdateCustomer = { id, n, p, a, notes -> repo.updateCustomerProfile(id, n, p, a, notes) },
                    onPayDebt = { c, amt, acc, notes -> repo.recordReceivablePayment(c, amt, acc, notes, uid, displayName) }
                )
                "closing" -> ClosingKasirScreen(
                    isAdmin = isAdmin,
                    userUid = uid,
                    accounts = accounts,
                    sales = sales,
                    miniAtm = miniAtm,
                    ppob = ppob,
                    receivables = receivables,
                    closings = closings,
                    onFinalizeClosing = { shift, start, end, openCash, actualCash, notes ->
                        val breakdown = ClosingMath.computeBreakdown(
                            sales = sales,
                            miniAtm = miniAtm,
                            ppob = ppob,
                            receivables = receivables,
                            accounts = accounts,
                            targetCashierUid = uid,
                            periodStartDate = start,
                            periodEndDate = end,
                            openingCash = openCash
                        )
                        repo.finalizeCashierClosing(
                            shiftLabel = shift,
                            periodStartDate = start,
                            periodEndDate = end,
                            openingCash = Formatters.roundMoney(openCash),
                            actualCash = actualCash,
                            notes = notes,
                            breakdown = breakdown,
                            userUid = uid,
                            userName = displayName
                        )
                    },
                    onReviewClosing = { closingId, status, note ->
                        if (!isAdmin) Result.failure(SecurityException("Hanya Admin."))
                        else repo.reviewCashierClosing(closingId, status, note, uid, displayName)
                    }
                )
            }
        }
    }
}
