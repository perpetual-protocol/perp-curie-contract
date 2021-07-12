pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { IERC20Metadata } from "./interface/IERC20Metadata.sol";
import { IVault } from "./interface/IVault.sol";

contract Vault is IVault, ReentrancyGuard, Ownable {
    using SafeMath for uint256;

    address public immutable override settlementToken;
    address public clearingHouse;

    uint8 public immutable override decimals;

    // key: trader, token address
    mapping(address => mapping(address => uint256)) private _balance;

    // key: token
    // TODO: change bool to collateral factor
    mapping(address => bool) private _collateralTokenMap;
    address[] private _collateralTokens;

    event Deposited(address indexed collateralToken, address indexed account, uint256 amount);

    constructor(address settlementTokenArg) {
        settlementToken = settlementTokenArg;
        decimals = IERC20Metadata(settlementTokenArg).decimals();

        _addCollateralToken(settlementTokenArg);
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // TODO add event
        clearingHouse = clearingHouseArg;
    }

    function deposit(
        address from,
        address token,
        uint256 amount
    ) external override nonReentrant() {
        // collateralToken not found
        require(_collateralTokenMap[token], "V_CNF");

        _increaseBalance(from, token, amount);

        // TODO change msgSender to "from" after tests fixed
        TransferHelper.safeTransferFrom(token, _msgSender(), address(this), amount);

        emit Deposited(token, from, amount);
    }

    function realizeProfit(address account, uint256 profit) external override onlyClearingHouse {
        _increaseBalance(account, settlementToken, profit);
    }

    function realizeLoss(address account, uint256 loss) external override onlyClearingHouse {
        uint256 settlementTokenBalance = _getBalance(account, settlementToken);
        if (settlementTokenBalance > loss) {
            _decreaseBalance(account, settlementToken, settlementTokenBalance.sub(loss));
            return;
        }

        _liquidate(account, loss.sub(settlementTokenBalance));
    }

    function balanceOf(address account) external view override returns (uint256) {
        uint256 settlementTokenValue;
        for (uint256 i = 0; i < _collateralTokens.length; i++) {
            address token = _collateralTokens[i];
            if (settlementToken != token) {
                // TODO get twap of settlement price * account's balance
                continue;
            }
            // is settlement token
            settlementTokenValue = settlementTokenValue.add(_getBalance(account, token));
        }

        return settlementTokenValue;
    }

    function _addCollateralToken(address token) private {
        // collateral token existed
        require(!_collateralTokenMap[token], "V_CTE");
        _collateralTokenMap[token] = true;
        _collateralTokens.push(token);
    }

    function _increaseBalance(
        address account,
        address token,
        uint256 amount
    ) private {
        _balance[account][token] = _getBalance(account, token).add(amount);
    }

    function _decreaseBalance(
        address account,
        address token,
        uint256 amount
    ) private {
        _balance[account][token] = _getBalance(account, token).sub(amount);
    }

    function _liquidate(address account, uint256 amount) private {
        for (uint256 i = 0; i < _collateralTokens.length; i++) {
            address token = _collateralTokens[i];
            if (settlementToken == token) {
                // during liquidation, there is no more settlement token
                continue;
            }
            // TODO swap token to settlement token until amount is 0
            _decreaseBalance(account, token, 0);
        }
        revert("TBD");
    }

    function _getBalance(address account, address token) private view returns (uint256) {
        return _balance[account][token];
    }

    modifier onlyClearingHouse() {
        // not clearing house
        require(clearingHouse == _msgSender(), "V_NCH");
        _;
    }
}
