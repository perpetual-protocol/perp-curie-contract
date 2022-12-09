// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    /// @param borrower The address of the borrower (actually is `Vault` address)
    /// @dev (Deprecated function, will be removed in the next release), In the previous version `Vault`
    ///      used to "borrow" from IF by calling `IF.borrow()`. We have since removed the behavior but
    ///      kept the variable name "borrower" for backward-compatibility
    event BorrowerChanged(address borrower);

    /// @param vault The address of the vault
    event VaultChanged(address vault);

    /// @param repaidAmount Repaid amount of the token
    /// @param tokenBalanceAfterRepaid InsuranceFund's token balance after repay
    event Repaid(uint256 repaidAmount, uint256 tokenBalanceAfterRepaid);

    /// @param distributionThreshold Distribution threshold amount
    /// @dev We will transfer fee to `SurplusBeneficiary` if `InsuranceFund` free collateral
    ///      is over distribution threshold
    event DistributionThresholdChanged(uint256 distributionThreshold);

    /// @param surplusBeneficiary The address of `SurplusBeneficiary`
    event SurplusBeneficiaryChanged(address surplusBeneficiary);

    /// @param surplus The amount of distribution
    /// @param insuranceFundCapacity The capacity of `insuranceFund` contract
    /// @param insuranceFundFreeCollateral The free collateral(usdc) of `insuranceFund` contract in vault
    /// @param distributionThreshold The distribution threshold amount
    event FeeDistributed(
        uint256 surplus,
        uint256 insuranceFundCapacity,
        uint256 insuranceFundFreeCollateral,
        uint256 distributionThreshold
    );

    /// @notice If insurance has negative accountValue of vault, will deposit amount to vault
    function repay() external;

    /// @notice If balance of `InsuranceFund` is over `distributionThreshold`, transfer diff to `SurplusBeneficiary`
    /// @dev Insurance Fund should only distribute revenues surplus earned on the platform.
    ///      In other words, funds directly held in the Insurance Fund contract (`insuranceFundWalletBalance`)
    ///      contributes to `insuranceFundTotalBalance` but not necessarily to `surplus`. Anyone can send funds to
    ///      Insurance Fund and help it reach `distributionThreshold` sooner, but once `surplus` exceeds
    ///      the revenues earned on the platform (`insuranceFundFreeCollateral`), sending more funds
    ///      won’t increase `surplus` further
    /// @return surplus The surplus of distribution
    function distributeFee() external returns (uint256 surplus);

    /// @notice Get settlement token address
    /// @return token The address of settlement token
    function getToken() external view returns (address token);

    /// @notice (Deprecated function, will be removed in the next release), Get borrower(`Vault`) address
    /// @return vault The address of `Vault`
    function getBorrower() external view returns (address vault);

    /// @notice Get `Vault` address
    /// @return vault The address of `Vault`
    function getVault() external view returns (address vault);

    /// @notice Get `InsuranceFund` capacity
    /// @return capacityX10_S The capacity value (settlementTokenValue + walletBalance) in settlement token's decimals
    function getInsuranceFundCapacity() external view returns (int256 capacityX10_S);

    /// @notice Get insurance distributution threshold, this value is for fee distribution
    /// @return distributionThreshold The distribution threshold number
    function getDistributionThreshold() external view returns (uint256 distributionThreshold);

    /// @notice Get SurplusBeneficiary
    /// @return surplusBeneficiary The address of `SurplusBeneficiary`
    function getSurplusBeneficiary() external view returns (address surplusBeneficiary);
}
