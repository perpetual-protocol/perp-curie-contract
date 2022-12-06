// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IClearingHouseConfig {
    /// @return maxMarketsPerAccount Max value of total markets per account
    function getMaxMarketsPerAccount() external view returns (uint8 maxMarketsPerAccount);

    /// @return imRatio Initial margin ratio
    function getImRatio() external view returns (uint24 imRatio);

    /// @return mmRatio Maintenance margin requirement ratio
    function getMmRatio() external view returns (uint24 mmRatio);

    /// @return liquidationPenaltyRatio Liquidation penalty ratio
    function getLiquidationPenaltyRatio() external view returns (uint24 liquidationPenaltyRatio);

    /// @return partialCloseRatio Partial close ratio
    function getPartialCloseRatio() external view returns (uint24 partialCloseRatio);

    /// @return twapInterval TwapInterval for funding and prices (market & index) calculations
    function getTwapInterval() external view returns (uint32 twapInterval);

    /// @return settlementTokenBalanceCap Max value of settlement token balance
    function getSettlementTokenBalanceCap() external view returns (uint256 settlementTokenBalanceCap);

    /// @return maxFundingRate Max value of funding rate
    function getMaxFundingRate() external view returns (uint24 maxFundingRate);

    /// @return isBackstopLiquidityProvider is backstop liquidity provider
    function isBackstopLiquidityProvider(address account) external view returns (bool isBackstopLiquidityProvider);

    /// @return markPriceMarketTwapInterval MarkPriceMarketTwapInterval for mark price calculations
    /// @return markPricePremiumInterval MarkPricePremiumInterval for mark price calculations
    function getMarkPriceConfigs()
        external
        view
        returns (uint32 markPriceMarketTwapInterval, uint32 markPricePremiumInterval);
}
