import AsyncStorage from '@react-native-async-storage/async-storage';
import * as NavigationBar from 'expo-navigation-bar';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  DeviceEventEmitter,
  Dimensions,
  FlatList,
  Image,
  Modal,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import * as IAP from 'react-native-iap';
import { SafeAreaView } from 'react-native-safe-area-context';

const { AppSwitchModule } = NativeModules;
const eventEmitter = DeviceEventEmitter;

const INTERSTITIAL_ID = 'ca-app-pub-5144004139813427/8304323709';
const BANNER_ID = 'ca-app-pub-5144004139813427/7182813723';

const INTERSTITIAL_REQUEST_OPTIONS = {
  requestNonPersonalizedAdsOnly: true,
  maxAdContentRating: 'PG',
  tagForChildDirectedTreatment: false,
  tagForUnderAgeOfConsent: false,
};

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

  // [수정] 애니메이션 로직 강화: 꺼지면 0으로 강제 고정
  useEffect(() => {
    let animation = null;
    if (!isEnabled) {
      // 1. 꺼져있을 때 (Offline): 깜빡임 시작
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(fadeAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(fadeAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
        ])
      );
      animation.start();
    } else {
      // 2. 켜졌을 때 (Online): 애니메이션 멈추고 투명도 0으로 강제 고정
      fadeAnim.stopAnimation();
      fadeAnim.setValue(0);
    }
    return () => {
        if(animation) animation.stop();
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

          if (pendingSaveRef.current && interstitialRef.current?.show) {
            interstitialRef.current.show();
          }
        });

        unsubscribeClosed = ad.addAdEventListener(mod.AdEventType.CLOSED, () => {
          adLoadedRef.current = false;
          setAdLoaded(false);

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
        });

        ad.load();
      } catch (e) {
        console.warn("GMA init skipped (runtime not ready):", e);
      }
    }, 0);

    const volumeListener =
      Platform.OS === 'android'
        ? DeviceEventEmitter.addListener('onVolumeDownTrigger', handleVolumeDownTrigger)
        : null;

    return () => {
      mounted = false;
      clearTimeout(t);
      try { unsubscribeLoaded && unsubscribeLoaded(); } catch {}
      try { unsubscribeClosed && unsubscribeClosed(); } catch {}
      try { unsubscribeError && unsubscribeError(); } catch {}
      adLoadedRef.current = false;
      interstitialRef.current = null;
      volumeListener?.remove();
      IAP.endConnection();
    };
  }, []);

  useEffect(() => {
    if (AppSwitchModule?.getSettings) {
      AppSwitchModule.getSettings().then((res: any) => {
        if (res) {
          setTargetPackage(res.targetPackage || '');
          setIsEnabled(res.isEnabled || false);
        }
      }).catch(console.error);
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

  async function handleVolumeDownTrigger() {
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
  }

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

    setIsEnabled((prev) => {
      const nextState = !prev;
      if (AppSwitchModule?.saveSettings) {
        AppSwitchModule.saveSettings(targetPackage, nextState);
      }
      return nextState;
    });
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

          {/* [수정] style에서 조건문을 빼고, 애니메이션 값(fadeAnim)만 바라보게 변경 */}
          <Animated.View 
            style={[styles.hintContainer, { opacity: fadeAnim }]}
            pointerEvents={isEnabled ? 'none' : 'auto'}
          >
            <Text style={styles.handEmoji}>👇 </Text>
            <Text style={styles.hintText}>TAP to{"\n"}START</Text>
          </Animated.View>
          
          <TouchableOpacity 
              onPress={toggleEnabledByLogo} 
              activeOpacity={0.9} 
              style={[styles.logoContainer, isEnabled && styles.logoGlow]}
          >
            <Image
              source={
                isEnabled
                  ? require('./assets/app-logo2.png')
                  : require('./assets/app-logo.png')
              }
              style={[styles.logoImage, { opacity: isEnabled ? 1 : 0.4 }]} 
              resizeMode="contain"
            />
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
          
          {/* ✅ [이동됨] 카드 컨테이너 바로 아래로 이동 */}
          <View style={styles.footerArea}>
            <TouchableOpacity style={styles.fabButton} onPress={handleSaveWithLogic}>
                <Text style={styles.fabIcon}>💾</Text>
                <Text style={styles.fabText}>Save</Text>
            </TouchableOpacity>
          </View>
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
  logoGlow: {
    shadowColor: '#dae1e7',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 40,
    elevation: 25,
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
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 50,
    zIndex: 20
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