// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    /// @param borrower The address of the borrower
    event BorrowerChanged(address borrower);

    /// @param repaidAmount Repaid amount of the token
    /// @param tokenBalanceAfterRepaid InsuranceFund's token balance after repay
    event Repaid(uint256 repaidAmount, uint256 tokenBalanceAfterRepaid);

    /// @notice If insurance has negative accountValue of vault, will deposit amount to vault
    function repay() external;

    /// @notice Get settlement token address
    /// @return token The address of settlement token
    function getToken() external view returns (address token);

    /// @notice Get borrower(`Vault`) address
    /// @return vault The address of `Vault`
    function getBorrower() external view returns (address vault);

    /// @notice Get `InsuranceFund` capacity
    /// @return capacityX10_S The capacity value (accountValue + walletBalance) in settlement token's decimals
    function getInsuranceFundCapacity() external view returns (int256 capacityX10_S);
}
