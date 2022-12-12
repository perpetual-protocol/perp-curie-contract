pragma solidity 0.7.6;

interface IClearingHouseConfigEvent {
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event TwapIntervalChanged(uint256 twapInterval);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);
    event SettlementTokenBalanceCapChanged(uint256 cap);
    event MarkPriceMarketTwapIntervalChanged(uint32 twapInterval);
    event MarkPricePremiumIntervalChanged(uint32 premiumInterval);
}
