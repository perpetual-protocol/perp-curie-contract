pragma solidity 0.7.6;

interface IClearingHouseConfigEvent {
    event MarkPriceMarketTwapIntervalChanged(uint32 twapInterval);
    event MarkPricePremiumIntervalChanged(uint32 premiumInterval);
}
