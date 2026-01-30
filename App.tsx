import AsyncStorage from '@react-native-async-storage/async-storage';
import * as NavigationBar from 'expo-navigation-bar';
import { useEffect, useRef, useState } from 'react';
import {
  Alert, // ✅ [추가] 포그라운드/백그라운드 감지 (앱 이탈 시 ON 적용 X + 세션 동기화)
  Animated,
  Dimensions,
  FlatList,
  Image,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  AppState as RNAppState,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import * as IAP from 'react-native-iap';
import { SafeAreaView } from 'react-native-safe-area-context';

const { AppSwitchModule } = NativeModules;
const eventEmitter = AppSwitchModule ? new NativeEventEmitter(AppSwitchModule) : null;

const INTERSTITIAL_ID = 'ca-app-pub-5144004139813427/8304323709';
const BANNER_ID = 'ca-app-pub-5144004139813427/7182813723';

const INTERSTITIAL_REQUEST_OPTIONS = {
  requestNonPersonalizedAdsOnly: true,
  maxAdContentRating: 'PG',
  tagForChildDirectedTreatment: false,
  tagForUnderAgeOfConsent: false,
};

// ✅ [추가] 30분 세션 + START 광고 게이트
const SESSION_START_AT_KEY = 'SWITCHING_SESSION_START_AT';
const SESSION_DURATION_MS = 30 * 60 * 1000;
const START_AD_OPEN_TIMEOUT_MS = 1500; // 1~2초 요구사항 반영
const START_AD_MAX_TRIES = 3; 

interface AppInfo {
  label: string;
  packageName: string;
  iconUri?: string;
}

interface AppState {
  targetPackage: string;
  isEnabled: boolean;
  isPremium: boolean;
}

const { width } = Dimensions.get('window');

export default function App() {
  const [gma, setGma] = useState<any>(null); 
  const [isEnabled, setIsEnabled] = useState<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const hintLoopRef = useRef<any>(null); // ✅ [추가] 힌트 애니메이션 stop 처리용(루프 누수 방지)

  // ✅ [추가] 로고 크로스페이드 진행률(0=청록(app-logo2) → 1=빨강(app-logo))
  const progressAnim = useRef(new Animated.Value(1)).current;
  const sessionStartAtRef = useRef<number | null>(null); // ✅ [추가] 30분 세션 시작 시각
  const sessionOffTimerRef = useRef<any>(null);          // ✅ [추가] 30분 종료 타이머
  const progressTimerRef = useRef<any>(null);            // ✅ [추가] 진행률 업데이트 타이머

  // ✅ [추가] START 광고 플로우 상태(연타/재시도/앱이탈 처리)
  const startFlowRef = useRef({
    isActive: false,
    tries: 0,
    adOpened: false,
    appLeft: false,
  });

  const startOpenTimeoutRef = useRef<any>(null);         // ✅ [추가] 1~2초 내 광고 미노출 감지
  const startTapLockRef = useRef<boolean>(false);        // ✅ [추가] 연타 방지
  const [startWaitModalVisible, setStartWaitModalVisible] = useState(false); // ✅ [추가]

  useEffect(() => {
    if (!isEnabled) {
      hintLoopRef.current?.stop?.(); // ✅ [추가]
      hintLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(fadeAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
        ])
      );
      hintLoopRef.current.start(); // ✅ [수정]
    } else {
      hintLoopRef.current?.stop?.(); // ✅ [추가]
      fadeAnim.setValue(0);
    }

    return () => {
      hintLoopRef.current?.stop?.(); // ✅ [추가]
    };
  }, [isEnabled]);

  const interstitialRef = useRef<any>(null);
  const adLoadedRef = useRef<boolean>(false);
  const pendingSaveRef = useRef<boolean>(false);

  const [appList, setAppList] = useState<AppInfo[]>([]);
  const [targetPackage, setTargetPackage] = useState<string>('');
  const [targetLabel, setTargetLabel] = useState<string>('');
  const [targetIconUri, setTargetIconUri] = useState<string>(''); 
  const [isPremium, setIsPremium] = useState<boolean>(false);
  const [adLoaded, setAdLoaded] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);

  const stateRef = useRef<AppState>({ targetPackage, isEnabled, isPremium });

  useEffect(() => {
    stateRef.current = { targetPackage, isEnabled, isPremium };
  }, [targetPackage, isEnabled, isPremium]);

  // ✅ [추가] 세션/타이머 유틸
  const clearSessionTimers = () => {
    if (sessionOffTimerRef.current) {
      clearTimeout(sessionOffTimerRef.current);
      sessionOffTimerRef.current = null;
    }
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  const getProgress = (startAt: number) => {
    const elapsed = Date.now() - startAt;
    const raw = elapsed / SESSION_DURATION_MS;
    return Math.max(0, Math.min(1, raw));
  };

  const expireSession = async () => {
    await AsyncStorage.removeItem(SESSION_START_AT_KEY);
    sessionStartAtRef.current = null;
    clearSessionTimers();
    progressAnim.setValue(1);

    // ✅ [추가] 30분 종료 시 자동 OFF (네이티브 설정도 OFF로)
    setIsEnabled(false);
    if (AppSwitchModule?.saveSettings) {
      AppSwitchModule.saveSettings(stateRef.current.targetPackage, false);
    }
  };

  const syncSession = async () => {
    const saved = await AsyncStorage.getItem(SESSION_START_AT_KEY);
    const startAt = saved ? Number(saved) : null;

    if (!startAt || Number.isNaN(startAt)) {
      sessionStartAtRef.current = null;
      clearSessionTimers();
      progressAnim.setValue(1);
      return null;
    }

    const elapsed = Date.now() - startAt;
    if (elapsed >= SESSION_DURATION_MS) {
      await expireSession();
      return null;
    }

    sessionStartAtRef.current = startAt;

    // ✅ [추가] 진행률 반영(아주 천천히 변화하지만 복귀 시 즉시 정확 보정)
    const p = getProgress(startAt);
    Animated.timing(progressAnim, { toValue: p, duration: 250, useNativeDriver: false }).start();

    // ✅ [추가] 정확히 30분에 자동 OFF
    if (sessionOffTimerRef.current) clearTimeout(sessionOffTimerRef.current);
    const remain = SESSION_DURATION_MS - (Date.now() - startAt);
    sessionOffTimerRef.current = setTimeout(() => {
      void expireSession();
    }, remain);

    // ✅ [추가] ON일 때 표시를 위해 진행률 주기 업데이트(백그라운드에서는 의미 없음)
    if (!progressTimerRef.current) {
      progressTimerRef.current = setInterval(() => {
        const s = sessionStartAtRef.current;
        if (!s) return;
        progressAnim.setValue(getProgress(s));
      }, 1000);
    }

    return startAt;
  };

  const startNewSessionAndEnable = async () => {
    const now = Date.now();
    await AsyncStorage.setItem(SESSION_START_AT_KEY, String(now));
    sessionStartAtRef.current = now;

    // ✅ [추가] ON 시작은 청록부터
    progressAnim.setValue(0);

    // ✅ [추가] ON으로 저장(프리미엄/광고 완료/광고 우회 포함 공통)
    setIsEnabled(true);
    if (AppSwitchModule?.saveSettings) {
      AppSwitchModule.saveSettings(stateRef.current.targetPackage, true);
    }

    // ✅ [추가] 타이머 재설정
    clearSessionTimers();
    sessionOffTimerRef.current = setTimeout(() => {
      void expireSession();
    }, SESSION_DURATION_MS);

    progressTimerRef.current = setInterval(() => {
      const s = sessionStartAtRef.current;
      if (!s) return;
      progressAnim.setValue(getProgress(s));
    }, 1000);
  };

  // ✅ [추가] START 광고 요청(1~2초 내 OPENED 안되면 모달, 2회 재시도, 3번째 실패면 그냥 구동)
  const requestStartWithAdGate = async () => {
    if (startTapLockRef.current) return; // ✅ [추가] 연타 방지
    startTapLockRef.current = true;
    setTimeout(() => { startTapLockRef.current = false; }, 700);

    startFlowRef.current.isActive = true;
    startFlowRef.current.tries += 1;
    startFlowRef.current.adOpened = false;
    startFlowRef.current.appLeft = false;

    const ad = interstitialRef.current;

    if (adLoadedRef.current && ad?.show) {
      ad.show();
    } else if (ad?.load) {
      ad.load(); // LOADED 리스너에서 show 처리
    }

    if (startOpenTimeoutRef.current) clearTimeout(startOpenTimeoutRef.current);
    startOpenTimeoutRef.current = setTimeout(() => {
      if (!startFlowRef.current.isActive) return;
      if (startFlowRef.current.adOpened) return;

      if (startFlowRef.current.tries >= START_AD_MAX_TRIES) {
        // ✅ [추가] 3번째도 광고가 안 나오면 그냥 구동
        startFlowRef.current.isActive = false;
        setStartWaitModalVisible(false);
        void startNewSessionAndEnable();
      } else {
        setStartWaitModalVisible(true);
      }
    }, START_AD_OPEN_TIMEOUT_MS);
  };

  // ✅ [추가] 앱 이탈 시(백그라운드) 광고 봐도 ON 적용 X + 포그라운드 복귀 시 세션 동기화
  useEffect(() => {
    void syncSession();

    const sub = RNAppState.addEventListener('change', (next) => { // ✅ [수정]
      if (next !== 'active' && startFlowRef.current.isActive) {
        startFlowRef.current.appLeft = true; // ✅ [추가] 앱 이탈 체크
      }
      if (next === 'active') {
        void syncSession(); // ✅ [추가] 복귀 시 진행률/만료 즉시 보정
      }
    });

    return () => {
      sub.remove();
      if (startOpenTimeoutRef.current) clearTimeout(startOpenTimeoutRef.current);
      clearSessionTimers();
    };
  }, []);

  useEffect(() => { 
    if (!targetPackage || !appList.length) return;
    const found = appList.find((a) => a.packageName === targetPackage);
    if (!found) return;
    setTargetLabel(found.label || '');
    setTargetIconUri(found.iconUri || '');
  }, [targetPackage, appList]);

  useEffect(() => {
    if (Platform.OS === 'android') {
  StatusBar.setTranslucent(true);
  StatusBar.setBackgroundColor("transparent");
  NavigationBar.setButtonStyleAsync("light");
}

    const checkSubscription = async () => {
      try {
        await IAP.initConnection();
        const purchases = await IAP.getAvailablePurchases();
        const hasSub = purchases.some((p: any) => p.productId === 'monthly_sub' && p.transactionId);
        setIsPremium(hasSub);
      } catch (err) {
        console.warn("구독 확인 실패:", err);
      }
    };
    checkSubscription();

     let mounted = true; 
    let unsubscribeLoaded: any = null; 
    let unsubscribeOpened: any = null; // ✅ [추가]
    let unsubscribeClosed: any = null; 
    let unsubscribeError: any = null; 

    const t = setTimeout(async () => { 
      try {
        const mod = require('react-native-google-mobile-ads'); 
        await mod.default().initialize();
        if (!mounted) return;

        setGma(mod); 

        const ad = mod.InterstitialAd.createForAdRequest(
          INTERSTITIAL_ID,
          INTERSTITIAL_REQUEST_OPTIONS
        ); 
        interstitialRef.current = ad; 

        unsubscribeLoaded = ad.addAdEventListener(mod.AdEventType.LOADED, () => {
          adLoadedRef.current = true; 
          setAdLoaded(true);

          // ✅ [추가] START 플로우가 광고를 기다리면 로드 즉시 show
          if (startFlowRef.current.isActive && interstitialRef.current?.show) {
            interstitialRef.current.show();
            return;
          }

          if (pendingSaveRef.current && interstitialRef.current?.show) {
            interstitialRef.current.show();
          }
        }); 

        unsubscribeOpened = ad.addAdEventListener(mod.AdEventType.OPENED, () => { // ✅ [추가]
          // ✅ [추가] 1~2초 내 OPENED 감지(모달 닫기)
          if (startFlowRef.current.isActive) {
            startFlowRef.current.adOpened = true;
            setStartWaitModalVisible(false);
          }
          if (startOpenTimeoutRef.current) clearTimeout(startOpenTimeoutRef.current);
        });

        unsubscribeClosed = ad.addAdEventListener(mod.AdEventType.CLOSED, () => {
          adLoadedRef.current = false; 
          setAdLoaded(false);

          // ✅ [추가] START 광고 시청 완료 처리(앱 이탈이면 ON 적용 X)
          if (startFlowRef.current.isActive) {
            const aborted = startFlowRef.current.appLeft;

            startFlowRef.current.isActive = false;
            startFlowRef.current.adOpened = false;
            startFlowRef.current.appLeft = false;
            startFlowRef.current.tries = 0;
            setStartWaitModalVisible(false);
            if (startOpenTimeoutRef.current) clearTimeout(startOpenTimeoutRef.current);

            if (!aborted) {
              void startNewSessionAndEnable();
            }
          }

          if (pendingSaveRef.current) {
            pendingSaveRef.current = false;
            saveSettings();
          }

          ad.load();
        }); 

        unsubscribeError = ad.addAdEventListener(mod.AdEventType.ERROR, (err: any) => { 
          adLoadedRef.current = false; 
          setAdLoaded(false);
          pendingSaveRef.current = false;
          console.warn("Interstitial ERROR:", err);

          // ✅ [추가] START 플로우: 3번째 실패면 광고 없이 구동, 아니면 모달
          if (startFlowRef.current.isActive) {
            if (startOpenTimeoutRef.current) clearTimeout(startOpenTimeoutRef.current);

            if (startFlowRef.current.tries >= START_AD_MAX_TRIES) {
              startFlowRef.current.isActive = false;
              setStartWaitModalVisible(false);
              void startNewSessionAndEnable();
            } else {
              setStartWaitModalVisible(true);
            }
          }
        });

        ad.load(); 
      } catch (e) {
        console.warn("GMA init skipped (runtime not ready):", e); 
      }
    }, 0);

    const volumeMod = NativeModules?.AppSwitchModule;
    const volumeEmitter = volumeMod ? new NativeEventEmitter(volumeMod) : null;
    const volumeListener = volumeEmitter?.addListener('onVolumeDownTrigger', handleVolumeDownTrigger);

    return () => {
      mounted = false; 
      clearTimeout(t); 
    try { unsubscribeLoaded && unsubscribeLoaded(); } catch {} 
      try { unsubscribeOpened && unsubscribeOpened(); } catch {} // ✅ [추가]
      try { unsubscribeClosed && unsubscribeClosed(); } catch {} 
      try { unsubscribeError && unsubscribeError(); } catch {} 
      adLoadedRef.current = false; 
      interstitialRef.current = null; 
      volumeListener?.remove();      IAP.endConnection();
    };
  }, []);

  useEffect(() => {
    if (AppSwitchModule?.getSettings) {
      AppSwitchModule.getSettings().then((res: any) => {
        if (res) {
          setTargetPackage(res.targetPackage || '');
          setIsEnabled(res.isEnabled || false);
        }
      });
    }

    if (AppSwitchModule?.getInstalledApps) {
      AppSwitchModule.getInstalledApps()
        .then((apps: AppInfo[]) => {
          const sortedApps = apps.sort((a, b) => a.label.localeCompare(b.label));
          setAppList(sortedApps);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, []);

    const handleVolumeDownTrigger = async () => {
    const { targetPackage: pkg, isEnabled: enabled, isPremium: premium } = stateRef.current;

    if (!enabled || !pkg) return;

    if (premium) {
      launchTargetApp();
      return;
    }

    const lastAdTime = await AsyncStorage.getItem('last_ad_time');
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    if (lastAdTime && now - parseInt(lastAdTime) < oneHour) {
      launchTargetApp();
    } else {
      if (adLoaded && interstitialRef.current?.show) {
        await AsyncStorage.setItem('last_ad_time', now.toString());
        interstitialRef.current.show();
      } else {
        launchTargetApp();
      }
    }
  };

  const launchTargetApp = () => {
    const { targetPackage: pkg } = stateRef.current;
    if (pkg && AppSwitchModule?.launchApp) {
      AppSwitchModule.launchApp(pkg);
    }
  };


  const handleSaveWithLogic = async () => {
    if (!targetPackage) {
      Alert.alert("알림", "앱을 선택해주세요.");
      return;
    }

    if (isPremium) {
      saveSettings();
      return;
    }

    const ad = interstitialRef.current;

    if (!ad?.show || !ad?.load) {
      Alert.alert("알림", "광고를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    pendingSaveRef.current = true;

    if (adLoadedRef.current) {
      ad.show();
    } else {
      ad.load();
      Alert.alert("알림", "광고 로딩 중입니다. 잠시만 기다려주세요.");
    }
  };

  const saveSettings = () => {
    if (AppSwitchModule?.saveSettings) {
      AppSwitchModule.saveSettings(targetPackage, isEnabled);
      Alert.alert("저장 성공", `[${targetLabel}] 설정이 시스템에 반영되었습니다.`);
    }
  };

  const toggleEnabledByLogo = async () => {
    // ✅ [추가] ON 시도 시 접근성 권한 체크는 유지
    if (!isEnabled) {
      if (AppSwitchModule?.isAccessibilityServiceEnabled) {
        const isGranted = await AppSwitchModule.isAccessibilityServiceEnabled();
        if (!isGranted) {
          Alert.alert(
            "접근성 권한 필요",
            "볼륨 키를 감지하려면 접근성 권한이 필요합니다.\n\n[설정 이동] 후 '설치된 앱' 목록에서 [스위칭 서비스]를 '사용'으로 바꿔주세요.",
            [
              { text: "나중에", style: "cancel" },
              { text: "설정 이동", onPress: () => AppSwitchModule.openAccessibilitySettings() }
            ]
          );
          return; 
        }
      }
    }

    // ✅ [추가] 이미 ON이면 → OFF(세션은 유지: 30분 안이면 다시 ON 시 광고 없이 진행)
    if (isEnabled) {
      setIsEnabled(false);
      if (AppSwitchModule?.saveSettings) {
        AppSwitchModule.saveSettings(targetPackage, false);
      }
      return;
    }

    // ✅ [추가] OFF → ON 시도
    // 1) 세션이 아직 살아있으면(30분 안) 광고 없이 즉시 ON
    const startAt = await syncSession();
    if (startAt) {
      setIsEnabled(true);
      if (AppSwitchModule?.saveSettings) {
        AppSwitchModule.saveSettings(targetPackage, true);
      }
      return;
    }

    // 2) 세션이 없거나(시작 전) 끝났으면(만료) → 프리미엄은 즉시 ON+세션 시작
    if (isPremium) {
      await startNewSessionAndEnable();
      return;
    }

    // 3) 무료면 START 광고 게이트 (1~2초 내 미노출이면 모달, 2회 재시도, 3번째도 실패면 그냥 구동)
    await requestStartWithAdGate();
  };

  const renderItem = ({ item }: { item: AppInfo }) => (
    <TouchableOpacity
      style={[styles.appItem, targetPackage === item.packageName && styles.selectedItem]}
      onPress={() => {
        setTargetPackage(item.packageName);
        setTargetLabel(item.label);
        setTargetIconUri(item.iconUri || ''); 
        setModalVisible(false);
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {item.iconUri && (
          <Image
            source={{ uri: item.iconUri }}
            style={{ width: 40, height: 40, marginRight: 10 }}
          />
        )}
        <View>
          <Text style={styles.appLabel}>{item.label}</Text>
          <Text style={styles.appPackage}>{item.packageName}</Text>
        </View>
      </View>
      {targetPackage === item.packageName && <Text style={styles.checkIcon}>✓</Text>}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" translucent={true} backgroundColor="transparent" />

      <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
        <View style={styles.headerArea}>
          <View style={[styles.premiumBadge, isPremium ? styles.badgePremium : styles.badgeFree]}>
            <Text style={styles.premiumText}>
               {isPremium ? "💎 PREMIUM" : "FREE VERSION"}
            </Text>
          </View>
        </View>

        <View style={styles.mainContent}>

          {!isEnabled && (
            <Animated.View style={[styles.hintContainer, { opacity: fadeAnim }]}>
              <Text style={styles.handEmoji}>👇 </Text>
              <Text style={styles.hintText}>TAP to{"\n"}START</Text>
            </Animated.View>
          )}
          
          <TouchableOpacity 
              onPress={toggleEnabledByLogo} 
              activeOpacity={0.9} 
              style={[styles.logoContainer, isEnabled && styles.logoGlow]}
          >
            {!isEnabled ? (
              <Image
                source={require('./assets/app-logo.png')}
                style={[styles.logoImage, { opacity: 0.4 }]}
                resizeMode="contain"
              />
            ) : (
              <View style={styles.logoStack}>
                <Animated.Image
                  source={require('./assets/app-logo2.png')}
                  style={[
                    styles.logoImage,
                    styles.logoAbs,
                    {
                      opacity: progressAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0],
                      }),
                    },
                  ]}
                  resizeMode="contain"
                />
                <Animated.Image
                  source={require('./assets/app-logo.png')}
                  style={[
                    styles.logoImage,
                    {
                      opacity: progressAnim,
                    },
                  ]}
                  resizeMode="contain"
                />
              </View>
            )}
          </TouchableOpacity>
          
          <Text style={[styles.statusLabel, { color: isEnabled ? '#1dd4f5' : '#555' }]}>
              {isEnabled ? "System Online" : "System Offline"}
          </Text>

          <View style={styles.cardContainer}>
              <Text style={styles.cardLabel}>TARGET APP</Text>
              <TouchableOpacity 
                  style={styles.appCard} 
                  onPress={() => setModalVisible(true)}
                  activeOpacity={0.7}
              >
                <View style={[styles.cardIcon, { backgroundColor: targetIconUri ? 'transparent' : (targetLabel ? '#007AFF' : '#222') }]}>
                      {targetIconUri ? ( 
                        <Image
                          source={{ uri: targetIconUri }}
                          style={{ width: 38, height: 38, borderRadius: 10 }}
                        />
                      ) : (
                        <Text style={styles.cardIconText}>{targetLabel ? targetLabel.charAt(0) : '?'}</Text>
                      )}
                  </View>
                  <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                          {targetLabel || "앱 선택하기"}
                      </Text>
                      <Text style={styles.cardSubTitle} numberOfLines={1}>
                          {targetPackage || "Touch to select target"}
                      </Text>
                  </View>
                  <View style={styles.cardArrow}>
                      <Text style={styles.arrowText}>›</Text>
                  </View>
              </TouchableOpacity>
          </View>
        </View>

        <View style={styles.footerArea}>
          <TouchableOpacity style={styles.fabButton} onPress={handleSaveWithLogic}>
              <Text style={styles.fabIcon}>💾</Text>
              <Text style={styles.fabText}>Save</Text>
          </TouchableOpacity>
        </View>


        <View style={styles.adContainer}>
          {gma?.BannerAd && gma?.BannerAdSize ? ( 
            <gma.BannerAd
              unitId={BANNER_ID}
              size={gma.BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
              requestOptions={{ 
                requestNonPersonalizedAdsOnly: true,
                maxAdContentRating: 'PG',
                tagForChildDirectedTreatment: false,
                tagForUnderAgeOfConsent: false,
              }}
            />
          ) : null}
        </View>

        <Modal
          animationType="fade"
          transparent={true}
          visible={startWaitModalVisible}
          onRequestClose={() => setStartWaitModalVisible(false)}
        >
          <View style={styles.startWaitOverlay}>
            <View style={styles.startWaitBox}>
              <Text style={styles.startWaitText}>
                시스템을 구동중입니다.{"\n"}잠시 후 광고가 나옵니다.
              </Text>

              <TouchableOpacity
                style={styles.startWaitBtn}
                activeOpacity={0.8}
                onPress={() => {
                  setStartWaitModalVisible(false);
                  void requestStartWithAdGate();
                }}
              >
                <Text style={styles.startWaitBtnText}>다시 시도</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <Modal
          animationType="fade"
          transparent={true}
          visible={modalVisible}
          onRequestClose={() => setModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select App</Text>
                <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.closeBtn}>
                  <Text style={styles.closeText}>✕</Text>
                </TouchableOpacity>
              </View>
              {loading ? (
                <Text style={styles.emptyText}>Loading apps...</Text>
              ) : (
                <FlatList
                  data={appList}
                  renderItem={renderItem}
                  keyExtractor={(item) => item.packageName}
                  contentContainerStyle={styles.listContent}
                  ListEmptyComponent={<Text style={styles.emptyText}>No apps found.</Text>}
                  indicatorStyle="white"
                />
              )}
            </View>
          </View>
        </Modal>

      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050505' },
  safeArea: { flex: 1 },

  headerArea: {
    height: 50,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    marginTop: Platform.OS === 'android'
      ? (StatusBar.currentHeight || 20) + 5
      : 10 + 12,                                  
    zIndex: 10
  },
  premiumBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  badgeFree: { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: '#333' },
  badgePremium: { backgroundColor: 'rgba(0,122,255,0.15)', borderColor: '#0052D4' },
  premiumText: { fontSize: 9, fontWeight: '800', color: '#ccc', letterSpacing: 0.5 },

  mainContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80 
  },
  logoContainer: {
    marginBottom: 25,
    borderRadius: 100,
  },
  logoImage: { width: 160, height: 160 },
  logoStack: { position: 'relative' }, // ✅ [추가]
  logoAbs: { position: 'absolute', top: 0, left: 0 }, // ✅ [추가]
  logoGlow: {
    shadowColor: '#dae1e7',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 40,
    elevation: 25,
  },

  // ✅ [추가] START 대기 모달
  startWaitOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  startWaitBox: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#111',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#222',
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  startWaitText: {
    color: '#d7d7d7',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 14,
  },
  startWaitBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#49a0c2',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  startWaitBtnText: {
    color: '#c8d0d4',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 40,
    textTransform: 'uppercase'
  },

  cardContainer: { width: '85%', maxWidth: 340 },
  cardLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.5
  },
  appCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121212',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2a2a2a'
  },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14
  },
  cardIconText: { fontSize: 18, color: '#fff', fontWeight: 'bold' },
  cardInfo: { flex: 1 },
  cardTitle: { color: '#eee', fontSize: 15, fontWeight: '600', marginBottom: 2 },
  cardSubTitle: { color: '#555', fontSize: 11 },
  cardArrow: { paddingLeft: 10 },
  arrowText: { color: '#444', fontSize: 20 },

  footerArea: {
    // ✅ [수정] absolute 제거 → TARGET APP 섹션과 하단 광고(adContainer) 사이에 자연 배치
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center', // ✅ [추가]
    paddingVertical: 16,      // ✅ [추가] 광고와 너무 붙지 않게
  },
  fabButton: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 10,
    paddingHorizontal: 40,       
    borderRadius: 4,              
    alignItems: 'center',
    borderWidth: 0.9,           
    borderColor: '#49a0c2',          
  },
  fabIcon: { display: 'none' },   
  fabText: { 
    color: '#c8d0d4',             
    fontSize: 12, 
    fontWeight: '400',            
    letterSpacing: 2,            
    textTransform: 'uppercase'
  },

  adContainer: {
    width: '100%',
    height: 60, 
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000'
  },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  modalContent: {
    width: '85%',
    height: '65%',
    backgroundColor: '#111',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#222',
    overflow: 'hidden'
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    backgroundColor: '#161616'
  },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  closeBtn: { padding: 5 },
  closeText: { color: '#666', fontSize: 18 },
  listContent: { padding: 10 },
  appItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginBottom: 6,
    borderRadius: 12,
    backgroundColor: '#1A1A1A'
  },
  selectedItem: { backgroundColor: '#111', borderColor: '#007AFF', borderWidth: 1 },
  appLabel: { fontSize: 15, fontWeight: '500', color: '#eee' },
  appPackage: { fontSize: 11, color: '#555', marginTop: 2 },
  checkIcon: { color: '#007AFF', fontWeight: 'bold', fontSize: 16, position: 'absolute', right: 15 },
  emptyText: { color: '#444', textAlign: 'center', marginTop: 50, fontSize: 12 },
  hintContainer: {
    position: 'absolute',
    flexDirection: 'row', 
    alignItems: 'center', 
    top: 80,             
    right: '12%',         
    zIndex: 30,
  },
  hintText: {
    color: '#cccccc',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
    textAlign: 'left',    
    lineHeight: 12,       
    marginLeft: -4,
  },
  handEmoji: {
    fontSize: 20,
    transform: [{ rotate: '45deg' }],
    },
});