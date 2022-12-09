// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { Collateral } from "../lib/Collateral.sol";

interface ICollateralManager {
    /// @notice Emitted when owner add collateral
    /// @param token address of token
    /// @param priceFeed address of price feed
    /// @param collateralRatio collateral ratio
    /// @param discountRatio discount ratio for the collateral liquidation
    /// @param depositCap max amount of collateral that can be deposited
    event CollateralAdded(
        address indexed token,
        address priceFeed,
        uint24 collateralRatio,
        uint24 discountRatio,
        uint256 depositCap
    );

    /// @notice Emitted when owner update the address of clearing house config
    /// @param clearingHouseConfig address of clearing house config
    event ClearingHouseConfigChanged(address indexed clearingHouseConfig);

    /// @notice Emitted when owner update the address of vault
    /// @param vault address of vault
    event VaultChanged(address indexed vault);

    /// @notice Emitted when owner update the price feed address of a collateral token
    /// @param token address of token
    /// @param priceFeed address of price feed
    event PriceFeedChanged(address indexed token, address priceFeed);

    /// @notice Emitted when owner update the collateral ratio of a collateral token
    /// @param token address of token
    /// @param collateralRatio collateral ratio
    event CollateralRatioChanged(address indexed token, uint24 collateralRatio);

    /// @notice Emitted when owner change the discount ratio
    /// @param token address of token
    /// @param discountRatio discount ratio for the collateral liquidation
    event DiscountRatioChanged(address indexed token, uint24 discountRatio);

    /// @notice Emitted when owner update the deposit cap of a collateral token
    /// @param token address of token
    /// @param depositCap max amount of the collateral that can be deposited
    event DepositCapChanged(address indexed token, uint256 depositCap);

    /// @notice Emitted when owner init or update the max collateral tokens that per account can have,
    /// 		this is can prevent high gas cost.
    /// @param maxCollateralTokensPerAccount max amount of collateral tokens that per account can have
    event MaxCollateralTokensPerAccountChanged(uint8 maxCollateralTokensPerAccount);

    /// @notice Emitted when owner init or update the maintenance margin ratio buffer,
    ///         the value provides a safe range between the mmRatio & the collateralMMRatio.
    /// @param mmRatioBuffer safe buffer number (bps)
    event MmRatioBufferChanged(uint24 mmRatioBuffer);

    /// @notice Emitted when owner init or update the debt non-settlement token value ratio,
    ///         maximum `debt / nonSettlementTokenValue` before the account's is liquidatable
    /// @param debtNonSettlementTokenValueRatio debt non-settlement token value ratio, ≤ 1
    event DebtNonSettlementTokenValueRatioChanged(uint24 debtNonSettlementTokenValueRatio);

    /// @notice Emitted when owner init or update the liquidation ratio,
    ///         the value presents the max repaid ratio of the collateral liquidation.
    /// @param liquidationRatio liquidation ratio, ≤ 1
    event LiquidationRatioChanged(uint24 liquidationRatio);

    /// @notice Emitted when owner init or update the clearing house insurance fund fee ratio,
    ///         charge fee for clearing house insurance fund.
    /// @param clInsuranceFundFeeRatio clearing house insurance fund fee ratio, ≤ 1
    event CLInsuranceFundFeeRatioChanged(uint24 clInsuranceFundFeeRatio);

    /// @notice Emitted when owner init or update the debt threshold,
    ///		 	maximum debt allowed before an account’s collateral is liquidatable.
    /// @param debtThreshold debt threshold
    event DebtThresholdChanged(uint256 debtThreshold);

    /// @notice Emitted when owner init or update the whitelisted debt threshold,
    ///		 	maximum debt allowed before an account’s collateral is liquidatable.
    /// @param whitelistedDebtThreshold whitelisted debt threshold
    event WhitelistedDebtThresholdChanged(address trader, uint256 whitelistedDebtThreshold);

    /// @notice Emitted when owner init or update the collateral value dust,
    ///			if a trader’s debt value falls below this dust threshold,
    /// 		the liquidator will ignore the liquidationRatio.
    /// @param collateralValueDust collateral value dust
    event CollateralValueDustChanged(uint256 collateralValueDust);

    /// @notice Get the address of vault
    /// @return vault address of vault
    function getVault() external view returns (address);

    /// @notice Get the address of clearing house config
    /// @return clearingHouseConfig address of clearing house config
    function getClearingHouseConfig() external view returns (address);

    /// @notice Get collateral config by token address
    /// @param token address of token
    /// @return collateral config
    function getCollateralConfig(address token) external view returns (Collateral.Config memory);

    /// @notice Get price feed decimals of the collateral token
    /// @param token address of token
    /// @return decimals of the price feed
    function getPriceFeedDecimals(address token) external view returns (uint8);

    /// @notice Get the price of the collateral token
    /// @param token address of token
    /// @return price of the certain period
    function getPrice(address token, uint256 interval) external view returns (uint256);

    /// @notice Get the max number of collateral tokens per account
    /// @return max number of collateral tokens per account
    function getMaxCollateralTokensPerAccount() external view returns (uint8);

    /// @notice Get the minimum `margin ratio - mmRatio` before the account's collateral is liquidatable
    /// @dev 6 decimals, same decimals as _mmRatio
    /// @return ratio
    function getMmRatioBuffer() external view returns (uint24);

    /// @notice Get the maximum `debt / nonSettlementTokenValue` before the account's collaterals are liquidated
    /// @dev 6 decimals
    /// @return ratio
    function getDebtNonSettlementTokenValueRatio() external view returns (uint24);

    /// @notice Get the maximum ratio of debt can be repaid in one transaction
    /// @dev 6 decimals. For example, `liquidationRatio` = 50% means
    ///      the liquidator can repay as much as half of the trader’s debt in one liquidation
    /// @return liquidation ratio
    function getLiquidationRatio() external view returns (uint24);

    /// @notice Get the insurance fund fee ratio when liquidating a trader's collateral
    /// @dev 6 decimals. For example, `clInsuranceFundFeeRatio` = 5% means
    ///      the liquidator will pay 5% of transferred settlement token to insurance fund
    /// @return insurance fund fee ratio
    function getCLInsuranceFundFeeRatio() external view returns (uint24);

    /// @notice Get the default maximum debt (denominated in settlement token) allowed
    ///			before an account’s collateral is liquidatable.
    /// @dev 6 decimals
    /// @return debtThreshold
    function getDebtThreshold() external view returns (uint256);

    /// @notice Get the maximum whitelisted debt (denominated in settlement token) allowed
    ///			before an account’s collateral is liquidatable.
    /// @dev 6 decimals
    /// @return debtThreshold
    function getDebtThresholdByTrader(address trader) external view returns (uint256);

    /// @notice Get the total whitelisted debt (denominated in settlement token) allowed
    /// @dev 6 decimals
    /// @return totalDebtThreshold
    function getTotalWhitelistedDebtThreshold() external view returns (uint256);

    /// @notice Get the threshold of the minium repaid.
    ///  		If a trader’s collateral value (denominated in settlement token) falls below the threshold,
    ///         the liquidator can convert it with 100% `liquidationRatio` so there is no dust left
    /// @dev 6 decimals
    /// @return Dust collateral value
    function getCollateralValueDust() external view returns (uint256);

    /// @notice Check if the given token is one of collateral tokens
    /// @param token address of token
    /// @return true if the token is one of collateral tokens
    function isCollateral(address token) external view returns (bool);

    /// @notice Require and get the the valid collateral maintenance margin ratio by mmRatioBuffer
    /// @param mmRatioBuffer safe margin ratio buffer; 6 decimals, same decimals as _mmRatio
    /// @return collateralMmRatio the collateral maintenance margin ratio
    function requireValidCollateralMmRatio(uint24 mmRatioBuffer) external view returns (uint24);
}
