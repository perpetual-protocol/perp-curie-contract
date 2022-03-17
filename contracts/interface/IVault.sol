// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IVault {
    /// @notice Emitted when trader deposit collateral into vault
    /// @param collateralToken The address of token that was deposited
    /// @param trader The address of trader
    /// @param amount The amount of token that was deposited
    event Deposited(address indexed collateralToken, address indexed trader, uint256 amount);

    /// @notice Emitted when trader withdraw collateral from vault
    /// @param collateralToken The address of token that was withdrawn
    /// @param trader The address of trader
    /// @param amount The amount of token that was withdrawn
    event Withdrawn(address indexed collateralToken, address indexed trader, uint256 amount);

    /// @notice Deposit collateral into vault
    /// @dev once multi-collateral is implemented, the token is not limited to settlementToken
    /// @param token The address of the token to deposit
    /// @param amountX10_D The amount of the token to deposit in decimals D (D = _decimals)
    function deposit(address token, uint256 amountX10_D) external;

    /// @notice Withdraw collateral from vault
    /// @dev once multi-collateral is implemented, the token is not limited to settlementToken
    /// @param token The address of the token sender is going to withdraw
    /// @param amountX10_D The amount of the token to withdraw in decimals D (D = _decimals)
    function withdraw(address token, uint256 amountX10_D) external;

    /// @notice Get the balance in vault of specified account
    /// @return balance The balance amount
    function getBalance(address account) external view returns (int256 balance);

    /// @notice Get free collateral amount of specified trader
    /// @param trader The address of the trader
    /// @return freeCollateral Max(0, amount of collateral available for withdraw or opening new positions or orders)
    function getFreeCollateral(address trader) external view returns (uint256 freeCollateral);

    /// @notice Get free collateral amount of specified trader and collateral ratio
    /// @dev There are three configurations for different insolvency risk tolerances: **conservative, moderate,
    /// aggressive**, we will start with the **conservative** one and gradually move to aggressive to
    /// increase capital efficiency
    /// @param trader The address of the trader
    /// @param ratio The margin requirement ratio, imRatio or mmRatio
    /// @return freeCollateralByRatio freeCollateral, by using the input margin requirement ratio; can be negative
    function getFreeCollateralByRatio(address trader, uint24 ratio)
        external
        view
        returns (int256 freeCollateralByRatio);

    /// @notice Get settlement token address
    /// @return settlementToken The address of settlement token
    function getSettlementToken() external view returns (address settlementToken);

    /// @notice Get settlement token decimals
    /// @dev cached the settlement token's decimal for gas optimization
    /// @return decimals The decimals of settlement token
    function decimals() external view returns (uint8 decimals);

    /// @notice Get the debt amount in vault
    /// @return debtAmount The debt amount
    function getTotalDebt() external view returns (uint256 debtAmount);

    /// @notice Get `ClearingHouseConfig` contract address
    /// @return clearingHouseConfig The address of `ClearingHouseConfig` contract
    function getClearingHouseConfig() external view returns (address clearingHouseConfig);

    /// @notice Get `AccountBalance` contract address
    /// @return accountBalance The address of `AccountBalance` contract
    function getAccountBalance() external view returns (address accountBalance);

    /// @notice Get `InsuranceFund` contract address
    /// @return insuranceFund The address of `InsuranceFund` contract
    function getInsuranceFund() external view returns (address);

    /// @notice Get `Exchange` contract address
    /// @return exchange The address of `Exchange` contract
    function getExchange() external view returns (address);

    /// @notice Get `ClearingHouse` contract address
    /// @return clearingHouse The address of `ClearingHouse` contract
    function getClearingHouse() external view returns (address);
}
